# Voice AI Backend (NestJS)

A NestJS backend application for a voice AI system with authentication, conversation management, and WebSocket support.

## Prerequisites

- Node.js (v18 or higher)
- MySQL database
- Yarn or npm package manager

## Project Setup

### 1. Install Dependencies

```bash
yarn install
# or
npm install
```

### 2. Database Configuration

The application uses MySQL. Configure your database connection by creating a `.env` file in the root directory:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USERNAME=root
DB_PASSWORD=
DB_DATABASE=farm_voice_ai
PORT=4000
NODE_ENV=development
```

**Note:** Make sure your MySQL database `farm_voice_ai` exists before running the application.

### 3. Run Database Migrations

If you have migrations, run them to set up your database schema:

```bash
# Add migration commands here if applicable
```

### 4. Start the Development Server

```bash
# Development mode with watch
yarn dev
# or
npm run dev

# Production mode
yarn start:prod
# or
npm run start:prod
```

The server will start on `http://localhost:4000` (or the port specified in your `.env` file).

## Available Scripts

- `yarn dev` - Start development server with watch mode
- `yarn build` - Build the project
- `yarn start` - Start the production server
- `yarn start:prod` - Start production server from dist folder
- `yarn test` - Run unit tests
- `yarn test:e2e` - Run end-to-end tests
- `yarn lint` - Run ESLint

## API Endpoints

The backend provides REST API endpoints and WebSocket support for real-time communication.

## Test Credentials

Use the following credentials to access the application:

- **Email:** `dyorajackson@gmail.com`
- **Password:** `123456`

## Project Structure

```
src/
├── entities/          # TypeORM entities
├── logic/             # Business logic modules
│   ├── agent/        # AI agent logic
│   ├── auth/         # Authentication logic
│   ├── conversation/  # Conversation management
│   ├── elastic/      # Elasticsearch integration
│   ├── stt/          # Speech-to-text
│   └── web/          # Web services
├── prompts/          # AI prompts
└── utils/            # Utility functions
```

## Additional Configuration

The application uses:
- **TypeORM** for database management
- **Socket.IO** for WebSocket connections
- **JWT** for authentication
- **Passport** for authentication strategies

Make sure all required environment variables are set before starting the server.
