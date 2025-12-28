import { Injectable } from '@nestjs/common';
import { ElevenLabsClient, RealtimeEvents, AudioFormat, RealtimeConnection, CommitStrategy, play } from "@elevenlabs/elevenlabs-js";
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
@Injectable()
export class ElevenLabsService {
    private elevenlabs: ElevenLabsClient;
    constructor(private readonly configService: ConfigService) {
        this.elevenlabs = new ElevenLabsClient({ apiKey: this.configService.get('ELEVENLABS_API_KEY') });
    }

    async createStream(
        onEvent: (msg: { type: 'partial' | 'final' | 'session-started'; text: string }) => void,
        onError: (err: any) => void,
    ): Promise<RealtimeConnection> {
        // Track last processed final transcript to prevent duplicates
        let lastFinalTranscript: string | null = null;
        let lastFinalTranscriptTime: number = 0;
        
        const connection = await this.elevenlabs.speechToText.realtime.connect({
            modelId: "scribe_v2_realtime",
            audioFormat: AudioFormat.PCM_16000,
            sampleRate: 16000,
            includeTimestamps: true,
            commitStrategy: CommitStrategy.VAD,
            vadSilenceThresholdSecs: 0.5,
        });
        
        //console.log('Connection established, setting up event listeners...');
        connection.on(RealtimeEvents.SESSION_STARTED, (data: any) => {
            // SessionStartedMessage might be an object, convert to string safely
            const text = typeof data === 'string' ? data : (data?.message || data?.text || JSON.stringify(data) || 'Session started');
            onEvent({ type: 'session-started', text });
        });

        connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data: any) => {
            //console.log('PARTIAL_TRANSCRIPT event received:', JSON.stringify(data));
            // The data has 'text' property, not 'transcript'
            const transcript = data?.text || data?.transcript;
            if (transcript) {
                try {
                    onEvent({ type: 'partial', text: transcript });
                } catch (error) {
                    console.error('Error calling onEvent for PARTIAL_TRANSCRIPT:', error);
                }
            } else {
                console.warn('PARTIAL_TRANSCRIPT data missing text/transcript:', data);
            }
        });

        connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data: any) => {
            // When includeTimestamps is true, COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS also fires
            // Skip this event to avoid duplicates - we'll handle it in COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS
            //console.log('COMMITTED_TRANSCRIPT event received (skipping - timestamps enabled):', JSON.stringify(data));
            return; // Skip this event when timestamps are enabled
        });

        connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, (data: any) => {
            //console.log('COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS event received:', JSON.stringify(data));
            // The data has 'text' property, not 'transcript'
            const transcript = data?.text || data?.transcript;
            if (transcript) {
                const now = Date.now();
                // Skip if this is a duplicate (same text within 500ms)
                if (transcript === lastFinalTranscript && (now - lastFinalTranscriptTime) < 500) {
                    //console.log('Skipping duplicate COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS:', transcript);
                    return;
                }
                
                //console.log('Calling onEvent with final transcript (with timestamps):', transcript);
                try {
                    onEvent({ type: 'final', text: transcript });
                    lastFinalTranscript = transcript;
                    lastFinalTranscriptTime = now;
                } catch (error) {
                    console.error('Error calling onEvent for COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS:', error);
                }
            } else {
                console.warn('COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS data missing text/transcript:', data);
            }
        });

        connection.on(RealtimeEvents.ERROR, (error: any) => {
            console.error("ElevenLabs error", error);
            onError(error);
        });

        connection.on(RealtimeEvents.AUTH_ERROR, (error: any) => {
            console.error("ElevenLabs auth error", error);
            onError(error);
        });

        connection.on(RealtimeEvents.QUOTA_EXCEEDED, (error: any) => {
            console.error("ElevenLabs quota exceeded", error);
            onError(error);
        });

        connection.on(RealtimeEvents.CLOSE, (data: any) => {
            //console.log("Connection closed", data);
        });

        return connection;
    }

    sendAudio(audioBuffer: Buffer, connection: RealtimeConnection): void {
        try {
            const chunkBase64 = audioBuffer.toString("base64");
            connection.send({
                audioBase64: chunkBase64,
                sampleRate: 16000,
            });
        } catch (error) {
            console.error("Error sending audio:", error);
        }
    }
    async generateAudio(text: string): Promise<string> {
        const voiceDir = path.join(process.cwd(), 'voice');

        const timestamp = Date.now();
        const filename = `voice_${timestamp}.mp3`;
        const filePath = path.join(voiceDir, filename);

        const audio = await this.elevenlabs.textToSpeech.convert('IKne3meq5aSn9XLyUdCD', {
            text: text,
            modelId: 'eleven_multilingual_v2',
            outputFormat: 'mp3_44100_128',
        });
        const reader = audio.getReader();
        const stream = new Readable({
            async read() {
                const { done, value } = await reader.read();
                if (done) {
                    this.push(null);
                } else {
                    this.push(value);
                }
            },
        });
        const file = fs.createWriteStream(filePath);
        stream.pipe(file);

        file.on('finish', () => {
            //console.log('Saved as output.mp3');
        });

        // ;

        // await play(stream);


        // Convert stream to buffer and save to file


        // Clean up old voice files (older than 1 hour)

        // Generate URL for the frontend
        return this.configService.get('BASE_URL')+"/voice/"+filename;

    }
}
