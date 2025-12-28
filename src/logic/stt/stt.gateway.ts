import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    MessageBody,
    ConnectedSocket,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RealtimeConnection, RealtimeEvents } from '@elevenlabs/elevenlabs-js';
import { ElevenLabsService } from './elevenlabs.service';
import { GeminiServiceService } from '../agent/gemini.service';
import { AgentService } from '../agent/agent.service';
import { Inject, forwardRef } from '@nestjs/common';
import * as fs from 'fs';
import { log } from 'console';
@WebSocketGateway({
    cors: { 
        origin: '*',
        credentials: true,
    }
})
export class SttGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
    @WebSocketServer()
    server: Server;

    afterInit(server: Server) {
        console.log('WebSocket Gateway initialized and attached to main server');
        // Configure server for production behind reverse proxy
        server?.engine?.on('connection_error', (err) => {
            console.error('WebSocket connection error:', err);
        });
    }

    constructor(
        private eleven: ElevenLabsService,
        private gemini: GeminiServiceService,
        @Inject(forwardRef(() => AgentService))
        private agentService: AgentService,
    ) { }

    private clientSessions = new Map<
        number,
        Socket

    >();

    async handleConnection(client: Socket) {
        //console.log('Client connected:', client.id);
        const userId = client?.handshake?.auth?.userId;
        if (!userId) return;
        this.linkUserToSocket(client, userId);
    }

    handleDisconnect(client: Socket) {
        //console.log('Client disconnected:', client.id);

        const key = this.getKeyByValue(this.clientSessions, client.id);
        if (!key) return;
        this.clientSessions.delete(key);
    }
    getKeyByValue(map, searchValue) {
        for (let [key, value] of map.entries()) {
            if (value?.id === searchValue) {
                return key;
            }
        }
        return undefined; // Return undefined if the value is not found
    }
    async linkUserToSocket(client: Socket, userId: number) {
        console.log('Linking user to socket:', client.id);
        this.clientSessions.set(userId, client);
        console.log('User', userId, 'linked to socket', client.id);
    }
    async sendThinking(userId: number, thinking: string) {
        const client = this.clientSessions.get(userId);
        if (!client) {
            console.warn('Client not found for userId:', userId);
            return;
        }
        client.emit('ai-thinking', thinking);
        this.server.emit('ai-thinking', thinking);
    }
    // private async reinitializeElevenLabsConnection(client: Socket) {
    //     console.log('Reinitializing ElevenLabs connection for client:', client.id);

    //     // Check if client is still connected
    //     if (!client.connected) {
    //         console.log('Client is no longer connected, skipping reinitialization:', client.id);
    //         return;
    //     }

    //     const session = this.clientSessions.get(client.id);
    //     if (!session) {
    //         console.warn('No session found for client during reinitialization:', client.id);
    //         return;
    //     }

    //     // Close the old connection if it exists
    //     try {
    //         if (session.elevenConnection) {
    //             session.elevenConnection.close();
    //         }
    //     } catch (error) {
    //         console.error('Error closing old ElevenLabs connection:', error);
    //     }

    //     // Create the callback function
    //     const onEventCallback = (event: { type: 'partial' | 'final' | 'session-started'; text: string }) => {
    //         try {
    //             // partial transcript
    //             if (event.type === 'partial') {
    //                 client.emit('partial', event.text);
    //                 const currentSession = this.clientSessions.get(client.id);
    //                 if (currentSession) {
    //                     currentSession.lastSpeech = Date.now();
    //                     currentSession.lastPartialTranscript = Date.now();
    //                     currentSession.pauseEmitted = false;
    //                     currentSession.voiceStoppedEmitted = false;
    //                 }
    //             }

    //             // final transcript
    //             if (event.type === 'final') {
    //                 client.emit('final', event.text);
    //                 const currentSession = this.clientSessions.get(client.id);
    //                 if (currentSession) {
    //                     currentSession.finalTranscript += ' ' + event.text;
    //                     currentSession.lastSpeech = Date.now();
    //                     currentSession.lastFinalTranscript = Date.now();
    //                     currentSession.lastPartialTranscript = Date.now();
    //                     currentSession.pauseEmitted = false;
    //                     currentSession.voiceStoppedEmitted = false;
    //                 }
    //             }

    //             if (event.type === 'session-started') {
    //                 client.emit('initialization-complete', 'Connection reinitialized');
    //             }
    //         } catch (error) {
    //             console.error('Error handling ElevenLabs event during reinitialization:', error);
    //         }
    //     };

    //     try {
    //         const newConnection = await this.eleven.createStream(
    //             onEventCallback,
    //             (err) => {
    //                 console.error('ElevenLabs error during reinitialization:', err);
    //             },
    //         );

    //         // Listen for close event to reinitialize again
    //         newConnection.on(RealtimeEvents.CLOSE, () => {
    //             console.log('ElevenLabs connection closed, reinitializing for client:', client.id);
    //             // Reinitialize after a short delay to avoid rapid reconnection loops
    //             // Only reinitialize if client is still connected
    //             if (client.connected) {
    //                 setTimeout(() => {
    //                     this.reinitializeElevenLabsConnection(client);
    //                 }, 1000);
    //             } else {
    //                 console.log('Client disconnected, not reinitializing ElevenLabs connection');
    //             }
    //         });

    //         // Update the session with the new connection
    //         session.elevenConnection = newConnection;
    //         console.log('ElevenLabs connection reinitialized for client:', client.id);
    //     } catch (error) {
    //         console.error('Error reinitializing ElevenLabs connection:', error);
    //     }
    // }




    // // AUDIO STREAM FROM CLIENT
    // @SubscribeMessage('audio')
    // handleAudio(
    //     @MessageBody() chunk: ArrayBuffer,
    //     @ConnectedSocket() client: Socket,
    // ) {
    //     const session = this.clientSessions.get(client.id);
    //     if (!session) return;

    //     // Update lastSpeech when audio is received (user is speaking)
    //     session.lastSpeech = Date.now();
    //     // Reset pause flag when new audio arrives
    //     session.pauseEmitted = false;

    //     try {
    //         this.eleven.sendAudio(Buffer.from(chunk), session.elevenConnection);
    //     } catch (error) {
    //         console.error('Error handling audio:', error);
    //     }
    // }
    // @SubscribeMessage('handle-request')
    // handleRequest(@ConnectedSocket() client: Socket) {
    //     client.emit('audio-url', 'http://localhost:4000/voice/voice_1764703319564.mp3')
    // }

    // @SubscribeMessage('close-audio')
    // closeAudio(@ConnectedSocket() client: Socket) {
    //     const session = this.clientSessions.get(client.id);
    //     if (!session) return;
    //     session.elevenConnection?.close();
    //     this.clientSessions.delete(client.id);
    // }

    // @SubscribeMessage('start-audio')
    // async startAudio(@ConnectedSocket() client: Socket) {
    //     //console.log('Starting audio for client:', client.id);

    //     // Create the callback function
    //     const onEventCallback = (event: { type: 'partial' | 'final' | 'session-started'; text: string }) => {
    //         //console.log('Gateway callback invoked - Event type:', event.type, 'Text:', event.text);
    //         try {
    //             // partial transcript
    //             if (event.type === 'partial') {
    //                 client.emit('partial', event.text);
    //                 const session = this.clientSessions.get(client.id);
    //                 if (session) {
    //                     session.lastSpeech = Date.now();
    //                     session.lastPartialTranscript = Date.now();
    //                     session.pauseEmitted = false; // Reset pause flag when new speech is detected
    //                     session.voiceStoppedEmitted = false; // Reset voice-stopped flag when new speech is detected
    //                     //console.log('Partial transcript received, updated lastPartialTranscript to:', session.lastPartialTranscript);
    //                 } else {
    //                     console.warn('Session not found for client:', client.id);
    //                 }
    //             }

    //             // final transcript
    //             if (event.type === 'final') {
    //                 console.log('Final transcript received:', event.text);
    //                 client.emit('final', event.text);
    //                 const session = this.clientSessions.get(client.id);
    //                 if (session) {
    //                     session.finalTranscript += ' ' + event.text;
    //                     session.lastSpeech = Date.now();
    //                     session.lastFinalTranscript = Date.now();
    //                     session.lastPartialTranscript = Date.now(); // Also update partial timestamp
    //                     session.pauseEmitted = false; // Reset pause flag when new speech is detected
    //                     session.voiceStoppedEmitted = false; // Reset voice-stopped flag when new speech is detected
    //                     //console.log('Final transcript received, updated timestamps');
    //                 } else {
    //                     console.warn('Session not found for client:', client.id);
    //                 }
    //             }

    //             if (event.type === 'session-started') {
    //                 client.emit('initialization-complete', 'Hello, how can I help you today?');
    //             }
    //         } catch (error) {
    //             console.error('Error handling ElevenLabs event in gateway:', error);
    //             console.error('Error message:', error.message);
    //             console.error('Error stack:', error.stack);
    //         }
    //     };

    //     const elevenConnection = await this.eleven.createStream(
    //         onEventCallback,
    //         (err) => {
    //             console.error('ElevenLabs error in gateway:', err);
    //         },
    //     );

    //     // Listen for close event to automatically reinitialize
    //     elevenConnection.on(RealtimeEvents.CLOSE, () => {
    //         console.log('ElevenLabs connection closed, reinitializing for client:', client.id);
    //         // Reinitialize after a short delay to avoid rapid reconnection loops
    //         // Only reinitialize if client is still connected
    //         if (client.connected) {
    //             setTimeout(() => {
    //                 this.reinitializeElevenLabsConnection(client);
    //             }, 1000);
    //         } else {
    //             console.log('Client disconnected, not reinitializing ElevenLabs connection');
    //         }
    //     });

    //     // Create session before setting up interval
    //     const initialTime = Date.now();
    //     this.clientSessions.set(client.id, {
    //         finalTranscript: '',
    //         lastSpeech: initialTime,
    //         lastFinalTranscript: initialTime,
    //         lastPartialTranscript: initialTime,
    //         interval: null,
    //         voiceDetectionInterval: null,
    //         elevenConnection,
    //         pauseEmitted: false,
    //         voiceStoppedEmitted: false,
    //     });

    //     // Silence detection loop - check every 500ms for 3 second pause
    //     const PAUSE_THRESHOLD_MS = 3000; // 3 seconds
    //     const CHECK_INTERVAL_MS = 500; // Check every 500ms

    //     const interval = setInterval(() => {
    //         const session = this.clientSessions.get(client.id);
    //         if (!session) {
    //             clearInterval(interval);
    //             return;
    //         }

    //         const now = Date.now();
    //         const timeSinceLastSpeech = now - session.lastFinalTranscript;
    //         const hasTranscript = session.finalTranscript.trim().length > 0;
    //         const pauseNotEmitted = !session.pauseEmitted;

    //         // Debug logging
    //         if (hasTranscript) {
    //             //console.log(`Pause check - Time since last speech: ${timeSinceLastSpeech}ms, Has transcript: ${hasTranscript}, Pause emitted: ${session.pauseEmitted}`);
    //         }

    //         // Emit pause if: 3 seconds have passed since last final transcript AND there's a transcript AND we haven't already emitted for this pause
    //         if (timeSinceLastSpeech >= PAUSE_THRESHOLD_MS && hasTranscript && pauseNotEmitted) {
    //             const transcriptToEmit = session.finalTranscript.trim();
    //             //console.log(`✅ Pause detected (${timeSinceLastSpeech}ms) for client ${client.id}, emitting transcript:`, transcriptToEmit);


    //             // Mark that we've emitted for this pause
    //             session.pauseEmitted = true;

    //             // Don't clear the transcript yet - keep it until new speech starts
    //             // The transcript will be cleared when new final transcripts arrive
    //         }
    //     }, CHECK_INTERVAL_MS);

    //     // Voice activity detection - check if partial transcripts have stopped
    //     const VOICE_STOP_THRESHOLD_MS = 1500; // 1.5 seconds without partial transcripts = voice stopped
    //     const VOICE_CHECK_INTERVAL_MS = 300; // Check every 300ms

    //     const voiceDetectionInterval = setInterval(() => {
    //         const session = this.clientSessions.get(client.id);
    //         if (!session) {
    //             clearInterval(voiceDetectionInterval);
    //             return;
    //         }

    //         const now = Date.now();
    //         const timeSinceLastPartial = now - session.lastPartialTranscript;

    //         // If no partial transcripts for threshold time, voice has stopped
    //         if (timeSinceLastPartial >= VOICE_STOP_THRESHOLD_MS && !session.voiceStoppedEmitted) {
    //             //console.log(`🔇 Voice stopped detected (${timeSinceLastPartial}ms since last partial transcript) for client ${client.id}`);
    //             client.emit('pause', {
    //                 timestamp: now,
    //                 timeSinceLastPartial: timeSinceLastPartial,
    //                 transcript: session.finalTranscript,
    //             });
    //             session.finalTranscript = '';
    //             session.voiceStoppedEmitted = true;
    //         }
    //     }, VOICE_CHECK_INTERVAL_MS);

    //     // Update session with intervals
    //     const session = this.clientSessions.get(client.id);
    //     if (session) {
    //         session.interval = interval;
    //         session.voiceDetectionInterval = voiceDetectionInterval;
    //     }
    // }
}
