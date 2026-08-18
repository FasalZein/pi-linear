import { runGenerationCommand } from './generate';

runGenerationCommand().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
