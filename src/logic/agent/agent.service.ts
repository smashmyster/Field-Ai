import { Injectable } from '@nestjs/common';
import { Message } from 'src/entities/messages.entity';
import { GeminiServiceService } from './gemini.service';
import { ConversationService } from '../conversation/conversation.service';
import { User } from 'src/entities/user.entity';
import { WeatherService } from './weather.service';
import { MessageType, Role } from 'src/utils/Role';
import { DataProcessing } from './data-processing';
import { ChemicalService } from './chemical.service';
import { TaskItem } from 'src/utils/task_item';
import { ElevenLabsService } from '../stt/elevenlabs.service';
import { AuthService } from '../auth/auth.service';
import { CLASSIFIER_PROMPT } from 'src/prompts/intent_prompt';
import { generateAnswerPrompt } from 'src/prompts/answer_prompt';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CropsService } from './crops.service';
import { PestsService } from './pests.service';
import { ImageService } from './image.service';
@Injectable()
export class AgentService {
  private readonly contextDir = path.join(process.cwd(), 'context');
  constructor(
    private readonly geminiService: GeminiServiceService,
    private readonly conversationService: ConversationService,
    private readonly weatherService: WeatherService,
    private readonly dataProcessing: DataProcessing,
    private readonly chemicalService: ChemicalService,
    private readonly elevenlabsService: ElevenLabsService,
    private readonly authService: AuthService,
    private readonly cropsService: CropsService,
    private readonly pestsService: PestsService,
    private readonly imageService: ImageService,
  ) {
  }

  async plan(message: string, userId: number, conversationId?: number, sources?: string[], isVoiceMode?: boolean) {
    const user = await this.authService.getProfile(userId);
    let conversation =
      await this.conversationService.ensureConversation(
        user.id,
        conversationId,
      );

    // Process images if sources are provided
    let visionResult = null;
    const imageArtifactIds: string[] = sources || [];
    this.geminiService.initiateThinking(userId);
    if (imageArtifactIds.length > 0) {
      // Process the first image for vision analysis
      const firstArtifactId = imageArtifactIds[0];
      const localPath = await this.imageService.getImageLocalPath(firstArtifactId);
      if (!localPath) {
        throw new Error(`Image not found for artifactId: ${firstArtifactId}`);
      }
      visionResult = await this.runVision(localPath);

      // Save vision results to conversation context
      await this.updateConversationContext(conversation.id, [{
        task: TaskItem.VISION,
        data: visionResult,
      }]);

      // Refresh conversation to get updated contextFrame
      conversation = await this.conversationService.getConversation(conversation.id);
    }

    const originalLanguage =
      await this.geminiService.detectLanguage(message, user.id);
    let englishQuery = message;
    if (originalLanguage !== 'en') {
      englishQuery = await this.geminiService.translateText(
        message,
        originalLanguage,
        'en',
        user.id,
      );
    }

    // Step 1: Detect intent using Gemini (with conversation history for context)
    // Note: We detect intent BEFORE saving the current message so history excludes it
    const intent = await this.detectIntent(englishQuery, conversation.contextFrame, conversation.id, user.id);
    // Save user message
    console.log('intent', intent);
    const saveMessage: Message = {
      id: 0,
      conversation,
      role: Role.USER,
      content: message,
      englishContent: englishQuery,
      originalLanguage,
      type: MessageType.TEXT,
      metadata: {},
      createdAt: new Date(),
    };

    const savedUserMessage = await this.conversationService.saveMessage(
      conversation.id,
      saveMessage,
    );

    // Link images to the message if sources are provided
    if (imageArtifactIds.length > 0) {
      await this.imageService.linkImagesToMessage(imageArtifactIds, savedUserMessage.id);
    }

    // Step 2: Fetch required data based on intent
    const dataResults = await this.fetchDataForIntent(intent, user as User, conversation, visionResult);

    // Step 3: Generate answer using Gemini with intent and data
    const state = {
      userId: user.id,
      conversationId: conversation.id,
      contextFrame: conversation.contextFrame || {},
    };

    const answerPrompt = generateAnswerPrompt(englishQuery, intent, state, dataResults);
    const answerResponse = await this.geminiService.generateContentStream(answerPrompt, user.id);
    let englishAnswer = answerResponse.text?.trim() || 'Sorry, I could not generate an answer.';

    // Translate back to the user's original language when needed
    let finalAnswer = englishAnswer;
    if (originalLanguage !== 'en') {
      finalAnswer = await this.geminiService.translateText(
        englishAnswer,
        'en',
        originalLanguage,
        user.id,
      );
    }

    // Save assistant message
    const savedAssistantMessage = await this.conversationService.saveMessage(conversation.id, {
      id: 0,
      conversation,
      role: Role.ASSISTANT,
      content: finalAnswer,
      englishContent: englishAnswer,
      originalLanguage,
      type: MessageType.TEXT,
      metadata: {},
      createdAt: new Date(),
    });

    // Update conversation context with fetched data
    const contextUpdates = this.prepareContextUpdates(dataResults, visionResult);
    await this.updateConversationContext(conversation.id, contextUpdates);

    // Generate and update title if conversation doesn't have one
    const updatedConversation = await this.conversationService.generateAndUpdateTitle(
      conversation.id,
      savedUserMessage.content,
      user.id
    );
    const refreshedConversation = updatedConversation
      ? await this.conversationService.getConversation(updatedConversation.id)
      : await this.conversationService.getConversation(conversation.id);

    const audioPath = isVoiceMode ? await this.elevenlabsService.generateAudio(finalAnswer) : null;//'http://localhost:4000/voice/voice_1764709916703.mp3';

    return {
      answer: finalAnswer,
      conversation: refreshedConversation,
      results: contextUpdates,
      audioPath
    };
  }

  /**
   * Detect intent from user query using Gemini with conversation history for context
   */
  private async detectIntent(query: string, contextFrame: any, conversationId: number, userId: number): Promise<any> {
    // Get last 10 messages for context
    const messages = await this.conversationService.getRecentHistoryAsc(conversationId, 10);

    // Format conversation history
    let historyText = '';
    if (messages.length > 0) {
      const historyMessages = messages.map((msg) => {
        const role = msg.role === Role.USER ? 'User' : 'Assistant';
        const content = msg.englishContent || msg.content;
        return `${role}: ${content}`;
      }).join('\n');
      historyText = `\n\nCONVERSATION HISTORY (for context):\n${historyMessages}`;
    }

    const contextHint = this.buildContextHint(contextFrame);
    const prompt = `${CLASSIFIER_PROMPT}${historyText}\n\nCURRENT USER QUERY: "${query}"${contextHint ? `\n\nCONTEXT: ${contextHint}` : ''}\n\nReturn ONLY valid JSON:`;

    try {
      const response = await this.geminiService.generateContentStream(prompt, userId);
      const jsonText = response.text?.trim() || '{}';
      // Remove any markdown code blocks if present
      const cleanedJson = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const intent = JSON.parse(cleanedJson);
      return intent;
    } catch (error) {
      console.error('Error detecting intent:', error);
      // Return default intent
      return {
        intent: 'general_question',
        targets: { crop: null, pestOrDisease: null, chemical: null },
        needs: {
          image: false,
          weather: false,
          vector_search: false,
          db_crop: false,
          db_pest: false,
          db_chemical: false,
          memory: false,
        },
        query: query,
      };
    }
  }

  /**
   * Fetch required data based on intent needs
   */
  private async fetchDataForIntent(
    intent: any,
    user: User,
    conversation: any,
    visionResult: any,
  ): Promise<any> {
    
    const conversationContext = conversation.contextFrame || {};
    const dataResults: any = {};

    // Handle vision/image data
    if (intent.needs.image && visionResult) {
      dataResults.vision = visionResult;
    }

    // Handle weather data
    if (intent.needs.weather) {
      if (user.latitude != null && user.longitude != null) {
        const weatherResult: any = await this.getWeather(user.latitude, user.longitude);
        dataResults.weather = weatherResult?.data;
      }
    }

    // Handle chemical lookup
    if (intent.needs.db_chemical||intent.needs.vector_search) {
      let chemicalName = intent.targets.chemical;
      const crop = intent.targets.crop;
      const pest = intent.targets.pestOrDisease;

      // Use chemical from context if not provided
      if (!chemicalName) {
        const bestMatch = conversationContext.bestMatch || conversationContext.chemical?.bestMatch;
        if (bestMatch?.name) {
          chemicalName = bestMatch.name;
        }
      }

      // Search if we have: chemical name, OR crop, OR pest
      // This allows searching for "chemicals for moths on cabbage" even without a specific chemical name
      if (chemicalName || crop || pest) {
        
        // Build query: use chemical name if provided, otherwise use crop + pest for semantic search
        let query = chemicalName || '';

        // If we have crop and/or pest, pass them separately for better semantic search
        const chemicalResult: any = await this.findChemical(
          query,
          conversationContext,
          crop,
          pest
        );
        dataResults.chemical = chemicalResult?.data;
      }
    }

    // Handle crop lookup (if needed in future)
    if (intent.needs.db_crop && intent.targets.crop) {
      // For now, just store the crop name
      dataResults.crop = { name: intent.targets.crop };
    }

    // Handle pest lookup (if needed in future)
    if (intent.needs.db_pest && intent.targets.pestOrDisease) {
      // For now, just store the pest name
      dataResults.pest = { name: intent.targets.pestOrDisease };
    }

    // Handle memory/conversation history
    if (intent.needs.memory) {
      const memoryResult: any = await this.memorySearch(user.id, conversation.id);
      dataResults.memory = memoryResult?.data;
    }

    // Add conversation context for follow-up questions
    if (conversationContext.bestMatch || conversationContext.chemical) {
      dataResults.conversationContext = {
        chemical: conversationContext.chemical,
        bestMatch: conversationContext.bestMatch,
        crop: conversationContext.crop,
        pest: conversationContext.pest,
        vision: conversationContext.vision,
      };
    }

    return dataResults;
  }

  /**
   * Prepare context updates from data results
   */
  private prepareContextUpdates(dataResults: any, visionResult: any): any[] {
    const contextUpdates: any[] = [];

    if (visionResult) {
      contextUpdates.push({
        task: TaskItem.VISION,
        data: visionResult,
      });

      if (visionResult.crop) {
        contextUpdates.push({
          task: TaskItem.CROP,
          data: visionResult.crop,
        });
      }

      if (visionResult.pest) {
        contextUpdates.push({
          task: TaskItem.PEST,
          data: visionResult.pest,
        });
      }

      if (visionResult.chemical) {
        contextUpdates.push({
          task: TaskItem.CHEMICAL,
          data: {
            success: true,
            bestMatch: visionResult.chemical,
            products: [visionResult.chemical],
          },
        });
      }
    }

    if (dataResults.weather) {
      contextUpdates.push({
        task: TaskItem.WEATHER,
        data: dataResults.weather,
      });
    }

    if (dataResults.chemical) {
      contextUpdates.push({
        task: TaskItem.CHEMICAL,
        data: dataResults.chemical,
      });
    }

    if (dataResults.crop) {
      contextUpdates.push({
        task: TaskItem.CROP,
        data: dataResults.crop,
      });
    }

    if (dataResults.pest) {
      contextUpdates.push({
        task: TaskItem.PEST,
        data: dataResults.pest,
      });
    }

    if (dataResults.memory) {
      contextUpdates.push({
        task: TaskItem.MEMORY,
        data: dataResults.memory,
      });
    }

    return contextUpdates;
  }



  async updateConversationContext(conversationId: number, results: any) {
    const conversation =
      await this.conversationService.getConversation(
        conversationId,
      );
    const conversationContext = conversation.contextFrame || {};
    for (const result of results) {
      const { task, data } = result;
      if (!data) {
        continue;
      }

      // Store a trimmed version of data to avoid huge JSON blobs in the DB.
      if (task === TaskItem.CHEMICAL) {
        const safeBestMatch = data.bestMatch || data.products?.[0];
        const safeProducts = Array.isArray(data.products)
          ? data.products.map((p: any) => ({
            id: p.id,
            name: p.name,
            score: p.score,
          }))
          : [];

        conversationContext[task] = {
          success: data.success,
          bestMatch: safeBestMatch,
          products: safeProducts,
        };
        conversationContext.bestMatch = safeBestMatch;
        continue;
      }

      conversationContext[task] = data;
    }
    await this.conversationService.updateConversation(
      conversationId,
      { contextFrame: conversationContext },
    );
  }


  private buildContextHint(contextFrame: any): string | null {
    if (!contextFrame) {
      return null;
    }

    const parts: string[] = [];

    // Include vision results if available
    const vision = contextFrame.vision;
    if (vision) {
      if (vision.crop?.name) {
        parts.push(`Image analysis detected crop: ${vision.crop.name}.`);
      }
      if (vision.pest?.name) {
        parts.push(`Image analysis detected disease/pest: ${vision.pest.name}.`);
      }
      if (vision.chemical?.name) {
        parts.push(`Recommended chemical from image analysis: ${vision.chemical.name}.`);
      }
      if (vision.reasoning) {
        parts.push(`Image analysis reasoning: ${vision.reasoning}.`);
      }
    }

    const crop = contextFrame.crop;
    if (crop?.name) {
      parts.push(`Current crop in context: ${crop.name}.`);
    }

    const bestMatch =
      contextFrame.bestMatch || contextFrame.chemical?.bestMatch;
    if (bestMatch?.name) {
      parts.push(
        `Current chemical in context: ${bestMatch.name}. When the user refers to "it", "this product", "this chemical", "the product", or "the chemical", they are referring to ${bestMatch.name}. For follow-up questions about this chemical (e.g., "what pests does it target?", "what can I use it for?", "what crops can I use this product on?"), use the chemical_followup tool to get conversation history and context. Only use chemical_lookup when searching for a NEW chemical by name.`,
      );
    }

    if (!parts.length) {
      return null;
    }

    return `IMPORTANT CONTEXT: ${parts.join(' ')} Only respond about these specific items mentioned in context. Do NOT mention other crops, pests, or chemicals unless the user explicitly asks about them.`;
  }

  private async runVision(imageUrl: string) {
    const crops = await this.cropsService.getCrops();
    const pests = await this.pestsService.getPests();
    const result = await this.geminiService.handleDetectImageDisease(imageUrl, crops, pests);
    const chemicals = await this.chemicalService.getChemicalByCropPest(result.crop_id, result.disease_id);
    const crop = crops.find(c => c.id == result.crop_id);
    const pest = pests.find(p => p.id == result.disease_id);
    const chemicalData = chemicals.map(c => c.chemical);

    return {
      crop,
      pest,
      chemical: chemicalData?.length > 0 ? chemicalData[0] : null,
      reasoning: result.reasoning,
    };
  }

  private getWeather(latitude: number, longitude: number) {
    return new Promise((resolve, reject) => {
      this.weatherService
        .handleWeatherForecast(latitude, longitude)
        .then((r) => {
          resolve({
            data: r,
            task: TaskItem.WEATHER,
          });
        });
    });
  }

  private async findChemical(c: string, conversationContext: any, crop?: string, pest?: string) {
    return new Promise((resolve, reject) => {
      this.chemicalService
        .searchProducts(c, conversationContext, crop, pest)
        .then((r) => {
          resolve({
            data: r,
            task: TaskItem.CHEMICAL,
          });
        });
    });
  }

  private findPest(p) {
    return new Promise((resolve, reject) => {
      resolve({
        data: { id: 2, name: p },
        task: TaskItem.PEST,
      });
    });
  }

  private async memorySearch(userId, conversationId) {
    return new Promise((resolve, reject) => {
      this.conversationService
        .getRecentHistoryAsc(conversationId)
        .then((r) => {
          resolve({
            data: r,
            task: TaskItem.MEMORY,
          });
        });
    });
  }

  async injestCropData(user: User) {
    return this.dataProcessing.injestCropData();
  }

  async injestPestData(user: User) {
    return this.dataProcessing.injestPestData();
  }

  async infoExtraction(obj: any) {
    return this.dataProcessing.infoExtraction(obj.id);
  }
}
