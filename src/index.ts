import { bootstrap } from './app.js';

const main = async (): Promise<void> => {
  const instance = await bootstrap();

  const shutdown = async (signal: string): Promise<void> => {
    instance.logger.info({ signal }, 'shutting down');
    await instance.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
