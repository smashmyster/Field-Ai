import { InjectRepository } from "@nestjs/typeorm";
import { Chemical } from "src/entities/chemicals.entity";
import { Repository } from "typeorm";
import { ElasticService } from "../elastic/elastic.service";
import { GeminiServiceService } from "./gemini.service";
import { CropProductPest } from "src/entities/crop_pest_chemical.entity";
const Fuse = require('fuse.js');
export class ChemicalService {
    constructor(
        @InjectRepository(Chemical)
        private chemicalRepository: Repository<Chemical>,
        private readonly elasticService: ElasticService,
        private readonly geminiService: GeminiServiceService,
        @InjectRepository(CropProductPest)
        private cropProductPestRepository: Repository<CropProductPest>,
    ) {


    }

    async searchProducts(query: string, conversationContext: any, crop?: string, pest?: string) {
        if (!query && !crop && !pest) {
            return conversationContext?.chemical;
        }
        // Build a semantic query for better embedding search
        let semanticQuery = query;
        if (crop && pest) {
            // Create a more semantic query when both crop and pest are present
            semanticQuery = `chemicals to treat ${pest} on ${crop} pesticides for ${pest} in ${crop}`;
            if (query) {
                semanticQuery = `${query} ${semanticQuery}`;
            }
        } else if (crop) {
            semanticQuery = query ? `${query} chemicals for ${crop}` : `chemicals for ${crop}`;
        } else if (pest) {
            semanticQuery = query ? `${query} pesticides for ${pest}` : `pesticides for ${pest}`;
        }

        const [embedding] = await this.geminiService.embedTexts([semanticQuery]);
        const check = await this.elasticService.elasticPost('/khula_products/_search', {
            knn: {
                field: "embedding",
                query_vector: embedding,
                k: 100, 
                num_candidates: 1000
            } 
        });
        let bestMatch = null;
        const products_p = check.hits.hits.map((hit: any) => ({ id: hit._source?.id, score: hit._score, name: hit._source?.name, description: hit._source?.searchText }));
        // console.log('products_p', products_p);
        let filteredProducts = products_p.filter((product: any) =>  product?.name?.toLowerCase().includes(query.toLowerCase()));
        // //console.log('filteredProducts', filteredProducts);
        if (filteredProducts.length === 0 && products_p.length > 0) {
            //console.log('No products found matching query, trying fuzzy search');
            const names = products_p.map((product: any) => product.name).filter((name: string) => name);
            if (names.length > 0) {
                const fuse = new Fuse(names, {
                    includeScore: true,
                    threshold: 0.5, // 0 = exact, 1 = match everything
                });
                const results = fuse.search(query).sort((a: any, b: any) => b.score - a.score);

                filteredProducts = results.map((result: any) => products_p.find((p: any) => p.name === result.item)).filter((p: any) => p);
                if (filteredProducts.length > 0) {
                    bestMatch = products_p.find((p: any) => p.name === results[0].item);
                }
            }
        } else {
            bestMatch = products_p[0];
        }
        if (filteredProducts.length === 0) {
            //console.log('No products found matching query', query);
            if (conversationContext.chemical) {
                bestMatch = conversationContext.bestMatch;
                filteredProducts = conversationContext?.chemical?.products;
            } else {
                return {
                    answer: `❌ No products found matching "${query}". Please try again.`,
                    success: false,
                    products: []
                };
            }

        }

        return {
            answer: `Found ${filteredProducts.length} products matching "${query}":\n${filteredProducts.map(p => `- ${p.name}`).join('\n')}`,
            success: true,
            products: filteredProducts,
            bestMatch
        };
    }
    async getChemicalByCropPest(cropId: number, pestId: number) {
        return await this.cropProductPestRepository.find({
            where: {
                crop: { id: cropId },
                pest: { id: pestId }
            },
            relations: ['chemical']
        });
    }
    
}