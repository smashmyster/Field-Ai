import { Body, Controller, Get, Param, Post, UseGuards, Request, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AgentService } from './agent.service';
import { ImageService } from './image.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ElevenLabsService } from '../stt/elevenlabs.service';
@Controller('agent')
export class AgentController {
    constructor(
        private readonly agentService: AgentService,
        private readonly imageService: ImageService,
        private readonly elevenlabsService: ElevenLabsService,
    ) { }
    @Post('generate-audio')
    async generateAudio(@Body() body: { text: string }) {
        return this.elevenlabsService.generateAudio(body.text);
    }
    @UseGuards(JwtAuthGuard)
    @Post('plan')
    async plan(@Body() body: { message: string, conversationId?: number, artifactId?: string, sources?: string[], isVoiceMode }, @Request() req) {
        const { user } = req;
        if (!user || !user.id) {
            throw new Error('User not found in request');
        }
        // Support both artifactId (legacy) and sources (new)
        const sources = body.sources || (body.artifactId ? [body.artifactId] : []);
        return this.agentService.plan(body.message, user.id, body.conversationId, sources, body.isVoiceMode);
    }

    @UseGuards(JwtAuthGuard)
    @Post('upload-image')
    @UseInterceptors(FileInterceptor('image'))
    async uploadImage(
        @UploadedFile() file: any,
        @Body() body: { conversationId?: number },
        @Request() req,
    ) {
        const { user } = req;
        if (!user || !user.id) {
            throw new Error('User not found in request');
        }
        if (!file) {
            throw new Error('No file uploaded');
        }
        const { artifactId, imageUrl } = await this.imageService.uploadImage(file, user, body.conversationId);
        return { artifactId, imageUrl };
    }
    @UseGuards(JwtAuthGuard)
    @Get('debug/adk-session/:conversationId')
    async debugAdkSession(@Param('conversationId') conversationId: string, @Request() req) {
        const { user } = req;
        if (!user || !user.id) {
            throw new Error('User not found in request');
        }
    }
    @UseGuards(JwtAuthGuard)
    @Post('injest-crop-data')
    async injestCropData(@Request() req) {
        const { user } = req;
        return this.agentService.injestCropData(user);
    }
    @Get('injest-chemical-data')
    async injestChemicalData(@Request() req) {
        const { user } = req;
        return this.agentService.injestChemicalData(user);
    }
    @UseGuards(JwtAuthGuard)
    @Post('injest-pest-data')
    async injestPestData(@Request() req) {
        const { user } = req;
        return this.agentService.injestPestData(user);
    }
    @Post('info-extraction')
    async infoExtraction(@Body() body: { id: string }) {
        return this.agentService.infoExtraction(body);
    }
}
