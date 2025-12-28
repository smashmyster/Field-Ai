import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ⭐ REQUIRED ⭐
  // Note: Gateways with explicit ports will create their own servers
  // IoAdapter is used for gateways without explicit ports
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });
  
  // Bind to 0.0.0.0 to accept external connections
  const port = process.env.PORT || 4000;
  await app.listen(port, '0.0.0.0');
  console.log(`Server running on http://0.0.0.0:${port}`);
  console.log(`WebSocket gateway attached to main server on port ${port}`);
}

bootstrap();
