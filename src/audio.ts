import fs from 'fs/promises'; // Use promises API for async operations
import path from 'path';
import Logger from './logger';
import Utils from './utils'; // Import Utils
import { llm } from './llm';

class AudioClient {
  private static instance: AudioClient;
  private logger = new Logger(); // Instantiate logger
  private utils = new Utils(); // Instantiate Utils

  private constructor() {}

  public static getInstance(): AudioClient {
    if (!AudioClient.instance) {
      AudioClient.instance = new AudioClient();
    }
    return AudioClient.instance;
  }

  /**
   * Generates audio from text with the speechTest route (src/llm/tasks.ts).
   * @param inputText The text to convert to speech.
   * @param instructions Optional instructions for the speech generation.
   * @returns The full path to the generated speech file.
   */
  public async generateAudio(
    inputText: string, // Make inputText required
    instructions?: string
  ): Promise<string> {
    const voice = 'ash'; // Hardcoded voice
    const randomString = this.utils.generateRandomString(); // Generate random string using Utils
    const outputFilename = `${randomString}.mp3`; // Use random string for filename

    // Construct the output directory path using PRIVATE_DIR
    const privateDir = process.env['PRIVATE_DIR'];
    if (!privateDir) {
      this.logger.log('PRIVATE_DIR environment variable is not defined');
      throw new Error('PRIVATE_DIR environment variable is not defined');
    }
    const outputDirectory = path.resolve(privateDir, 'audio');
    const speechFile = path.resolve(outputDirectory, outputFilename);

    try {
      this.logger.log(
        `Generating audio for text: "${inputText}" using voice: ${voice}, saving to: ${speechFile}`
      );
      const { data: buffer } = await llm.speech('speechTest', {
        voice,
        text: inputText,
        instructions: instructions || '',
      });

      // Ensure the output directory exists
      await fs.mkdir(outputDirectory, { recursive: true });

      await fs.writeFile(speechFile, buffer);
      this.logger.log(`Audio file saved successfully to: ${speechFile}`);
      return speechFile;
    } catch (error) {
      this.logger.log(`Error generating audio: ${(error as Error).message}`);
      // Provider errors reach us unchanged; these are the fields their SDKs set.
      const details = error as { status?: unknown; code?: unknown; type?: unknown };
      if (details?.status !== undefined) {
        this.logger.log(`TTS API Error Status: ${details.status}`);
        this.logger.log(`TTS API Error Message: ${(error as Error).message}`);
        this.logger.log(`TTS API Error Code: ${details.code}`);
        this.logger.log(`TTS API Error Type: ${details.type}`);
      }
      throw error; // Re-throw the error after logging
    }
  }
}

export default AudioClient;
