import { GeminiServiceService } from "./gemini.service";
import { Repository } from "typeorm";
import { Crop } from "src/entities/crop.entity";
import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ElasticService } from "../elastic/elastic.service";
import { Pest } from "src/entities/pest.entity";
import { Chemical } from "src/entities/chemicals.entity";
import { CropProductPest } from "src/entities/crop_pest_chemical.entity";
import { ChemicalPest } from "src/entities/chemical_pest.entity";
import { CropProduct } from "src/entities/crop_chemical.entity";
import { CropPest } from "src/entities/crop_pest.entity";
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import OpenAI from 'openai';
import { ConfigService } from '@nestjs/config';
const { PDFParse } = require('pdf-parse');

@Injectable()
export class DataProcessing {
    private openai: OpenAI;
    constructor(
        @Inject(forwardRef(() => GeminiServiceService))
        private readonly geminiService: GeminiServiceService,
        @InjectRepository(Crop)
        private cropRepository: Repository<Crop>,
        private readonly elasticService: ElasticService,
        @InjectRepository(Pest)
        private pestRepository: Repository<Pest>,
        @InjectRepository(Chemical)
        private chemicalRepository: Repository<Chemical>,
        @InjectRepository(CropProductPest)
        private cropProductPestRepository: Repository<CropProductPest>,
        @InjectRepository(ChemicalPest)
        private chemicalPestRepository: Repository<ChemicalPest>,
        @InjectRepository(CropProduct)
        private cropProductRepository: Repository<CropProduct>,
        @InjectRepository(CropPest)
        private cropPestRepository: Repository<CropPest>,
        @InjectRepository(Chemical)
        private productRepository: Repository<Chemical>,
        private readonly configService: ConfigService,
    ) {
        this.openai = new OpenAI({ apiKey: this.configService.get('OPENAI_API_KEY') });
    }

    async getAllProducts() {
        const url = this.configService.get<string>('GRAPH_URL') ?? 'https://graph.khuladev.co.za/graphql';
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: '*/*',
            },
            body: JSON.stringify({
                operationName: null,
                variables: {},
                query: `{
  getAllInputProducts {
    id
    name
    labelLink
    active
  }
}`,
            }),
        });
        if (!response.ok) {
            throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
        }
        const json = await response.json();
        return json?.data?.getAllInputProducts ?? [];
    }
    async injestCropData() {
        const crops = await this.cropRepository.find();
        // if (crops.length > 0) {
        //     return;
        // }
        for (const crop of crops) {
            const [cropEmbeddings] = await this.geminiService.embedTexts([crop.name]);
            const cropData = {
                "id": crop.id,
                "name": crop.name,
                "searchText": crop.name,
                "embedding": cropEmbeddings
            }
            await this.elasticService.elasticPost(`/crops/_update/${crop.id}`, {
                doc: cropData,
                doc_as_upsert: true
            });
        }
    }

    async injestPestData() {
        const pests = await this.pestRepository.find();
        for (const pest of pests) {
            const [pestEmbeddings] = await this.geminiService.embedTexts([pest.name]);
            const pestData = {
                "id": pest.id,
                "name": pest.name,
                "searchText": pest.name,
                "embedding": pestEmbeddings
            }
            await this.elasticService.elasticPost(`/pests/_update/${pest.id}`, {
                doc: pestData,
                doc_as_upsert: true
            });
        }
    }

    /**
     * Validates if a URL is valid and accessible
     * @param urlString - The URL to validate
     * @returns Promise<boolean> - True if URL is valid and accessible
     */
    private async isValidLink(urlString: string): Promise<boolean> {
        if (!urlString || typeof urlString !== 'string') {
            return false;
        }

        try {
            // Validate URL format
            const url = new URL(urlString);
            if (!['http:', 'https:'].includes(url.protocol)) {
                //console.log(`Invalid protocol for URL: ${urlString}`);
                return false;
            }

            // Check if URL is accessible with HEAD request
            return await this.checkUrlAccessibility(urlString);
        } catch (error) {
            //console.log(`Invalid URL format: ${urlString}`, error.message);
            return false;
        }
    }
    async injestChemicals() {
        const products = await this.getAllProducts();
        console.log("products", products[0]);
        let count = 0;

        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            count = i;
            if (product.labelLink && product.labelLink.length > 0 && product.active) {
                const parser = new PDFParse({ url: product.labelLink });
                let pdf = "";
                if (parser) {
                    try {
                        pdf = (await parser.getText())?.text || "";
                    } catch (error) {
                        console.log("error", error);
                        pdf = "";
                    }
                }
                let labelText = `${product.id}\n\n${product.name}\n\n ${pdf}`;
                if (labelText.length > 0) {
                    const [productEmbedding] = await this.geminiService.embedTexts([labelText]);
                    let productData = {
                        id: product.id,
                        name: product.name,
                        searchText: labelText,
                        embedding: productEmbedding,
                        labelLink: product.labelLink,
                    }
                    console.log("productData", productData);
                    // return productData
                    const response = await this.elasticService.elasticPost(`/khula_products/_update/${product.id}`, {
                        doc: productData,
                        doc_as_upsert: true
                    });
                    console.log("response", ` ${count} of ${products.length}`, product.id);
                }
            } else {
                console.log("response", ` No label link ${count} of ${products.length}`, product.id);
            }
            console.log(i, products.length)

        }
        return count;
    }
    /**
     * Checks if a URL is accessible by making a HEAD request
     * @param urlString - The URL to check
     * @returns Promise<boolean> - True if URL is accessible
     */
    private async checkUrlAccessibility(urlString: string): Promise<boolean> {
        return new Promise((resolve) => {
            try {
                const url = new URL(urlString);
                const client = url.protocol === 'https:' ? https : http;

                const options = {
                    hostname: url.hostname,
                    port: url.port || (url.protocol === 'https:' ? 443 : 80),
                    path: url.pathname + url.search,
                    method: 'HEAD',
                    timeout: 10000, // 10 second timeout
                };

                const req = client.request(options, (res) => {
                    // Accept status codes 200-399 as valid
                    const isValid = res.statusCode >= 200 && res.statusCode < 400;
                    resolve(isValid);
                });

                req.on('error', (error) => {
                    //console.log(`Error checking URL accessibility: ${urlString}`, error.message);
                    resolve(false);
                });

                req.on('timeout', () => {
                    req.destroy();
                    //console.log(`Timeout checking URL: ${urlString}`);
                    resolve(false);
                });

                req.setTimeout(10000);
                req.end();
            } catch (error) {
                //console.log(`Error in checkUrlAccessibility: ${urlString}`, error.message);
                resolve(false);
            }
        });
    }


    /**
     * Chunks an array into smaller arrays of specified size
     */
    private chunkArray<T>(array: T[], chunkSize: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }

    /**
     * Processes a single chemical
     */
    private async processChemical(chemical: Chemical, crops: Crop[], pests: Pest[], index: number, total: number): Promise<void> {
        try {
            //console.log(`Processing chemical ${index + 1} of ${total} (ID: ${chemical.id})`);

            // Validate link before processing
            if (!chemical.labelLink) {
                //console.log(`Skipping chemical ${chemical.id}: No labelLink provided`);
                return;
            }

            const isValidLink = await this.isValidLink(chemical.labelLink);
            if (!isValidLink) {
                //console.log(`Skipping chemical ${chemical.id}: Invalid or inaccessible link: ${chemical.labelLink}`);
                return;
            }

            const parser = new PDFParse({ url: chemical.labelLink });
            let pdf = "";
            if (parser) {
                try {
                    const ff = await parser?.getText();
                    pdf = ff?.text || "";
                } catch (error) {
                    //console.log(`Error parsing PDF for chemical ${chemical.id}:`, error);
                    pdf = "";
                }
            }

            if (pdf.length === 0) {
                //console.log(`Skipping chemical ${chemical.id}: No PDF content extracted`);
                return;
            }

            const prompt = `
        Extract the following details from the given chemical product label:
        
        - Product Name
        - Type (e.g., Fungicide, Insecticide)
        - Weight
        - Active Ingredients (name and concentration)
        - Uses (list the crops or purposes) Please use this list of produce and return the id and name only ${JSON.stringify(crops)}  Do not diviate from this list ever. If there is no result please do create your own products.Also include the pests targeted from this list ${JSON.stringify(pests)}. Please return the pestName and pestId. If there is no use, please give me a null value
        - PHI (Pre-Harvest Interval) for different crops
        - Precautions for any safety resaons
        Format the response in this JSON structure:
        {
          "product_name": "<name>",
          "type": "<type>",
          "active_ingredients": [
                                   {"name": "<ingredient1>","concentration": "<concentration>"},
        ]                     
            ,
          "uses": [{
            "crop": "<crop1>",
            "id": "<id>",
            "applicationRate": "<applicationRate>",
            "bugsTargeted":[
                {
                    "bug": "<bug1>",
                    "id": "<id>",
                    "dosage": "<dosage>",
                    "applicationRemarks": "<application>"
                }
            ]}],
          "PHI": {
            "<crop1>": "<duration>",
            "<crop2>": "<duration>"
          },
          "link": "${chemical.labelLink}"
          "precautions": "<precautions>"
        }
        Please try to focus on Na,Ca,K,P nutrients. If they are not there it's ok
        Please don't include \`\`\`json\`\`\` in the response.
        Here is the extracted text from the product label:
        ${pdf}
        
        Remember not to diviate from the data given ever`;
            const completion = await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    {
                        "role": "system", "content": "expert agronomist"
                    },
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
            });
            const result = completion.choices[0].message.content.replace('```json', '').replace('```', '').trim();


            let data;
            try {
                data = JSON.parse(result);
            } catch (error) {
                //console.log(`Error parsing JSON for chemical ${chemical.id}:`, error);
                return;
            }

            await this.chemicalRepository.update(chemical.id, {
                activeIngredient: JSON.stringify(data.active_ingredients),
                manufacturer: data.manufacturer,
                metadata: data.active_ingredients,
                type: data.type,
            });


            if (!data.uses || !Array.isArray(data.uses)) {
                return;
            }

            for (const use of data.uses) {
                const crop = crops.find(c => c.id === use.id);

                if (crop) {
                    let cropProduct: any = await this.cropProductRepository.findOne({
                        where: {
                            crop: { id: crop.id },
                            chemical: { id: chemical.id }
                        }
                    });

                    if (!cropProduct && crop?.id) {
                        cropProduct = await this.cropProductRepository.save({
                            crop: { id: crop.id },
                            chemical: { id: chemical.id }
                        });
                    }

                    const bugsTargeted = use.bugsTargeted || [];
                    for (const bug of bugsTargeted) {
                        let cropPest = await this.cropPestRepository.findOne({
                            where: { crop: { id: crop.id }, pest: { id: bug.id } }
                        });

                        if (!cropPest) {
                            cropPest = await this.cropPestRepository.save({
                                crop: { id: crop.id },
                                pest: { id: bug.id }
                            });
                        }

                        let chemicalPest = await this.chemicalPestRepository.findOne({
                            where: { chemical: { id: chemical.id }, pest: { id: bug.id } }
                        });

                        if (!chemicalPest) {
                            chemicalPest = await this.chemicalPestRepository.save({
                                chemical: { id: chemical.id },
                                pest: { id: bug.id }
                            });
                        }

                        let cropProductPest = await this.cropProductPestRepository.findOne({
                            where: {
                                crop: { id: crop.id },
                                pest: { id: bug.id },
                                chemical: { id: chemical.id }
                            }
                        });

                        if (!cropProductPest) {
                            if (crop?.id && bug?.id && chemical?.id) {
                                cropProductPest = await this.cropProductPestRepository.save({
                                    crop: { id: crop.id },
                                    pest: { id: bug.id },
                                    chemical: { id: chemical.id }
                                });
                            }
                        }
                    }
                }
            }

            //console.log(`Successfully processed chemical ${chemical.id}`);
        } catch (error) {
            console.error(`Error processing chemical ${chemical.id}:`, error);
            // Don't throw - let other chemicals in the batch continue processing
        }
    }

    async infoExtraction(id: number) {
        const chemicalPestRepository = await this.chemicalRepository.find();
        const ranChecmilca = await this.cropProductRepository.find({
            relations: ['chemical']
        });
        const uniqueChemicals = Array.from(new Set(ranChecmilca.map(chemical => chemical.chemical.id)));
        const chemicals = chemicalPestRepository.filter(chemical => !uniqueChemicals.includes(chemical.id));

        // Load crops and pests once (they're the same for all chemicals)
        const crops = await this.cropRepository.find();
        const pests = await this.pestRepository.find();

        //console.log(`Total chemicals to process: ${chemicals.length}`);
        //console.log(`Processing in batches of 10`);

        // Split chemicals into batches of 10
        const batches = this.chunkArray(chemicals, 10);

        // Process each batch in parallel
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            //console.log(`\nProcessing batch ${batchIndex + 1} of ${batches.length} (${batch.length} chemicals)`);

            // Process all chemicals in this batch in parallel
            await Promise.all(
                batch.map((chemical, indexInBatch) =>
                    this.processChemical(
                        chemical,
                        crops,
                        pests,
                        batchIndex * 10 + indexInBatch,
                        chemicals.length
                    )
                )
            );

            //console.log(`Completed batch ${batchIndex + 1} of ${batches.length}`);
        }

        //console.log(`\nAll chemicals processed successfully!`);
        return "Done";
    }
}
