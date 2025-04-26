import fs from 'fs/promises'; // Use promises API for async operations
import path from 'path';
import OpenAI from 'openai';
import Logger from './logger';
import { nanoid } from 'nanoid'; // Import nanoid for random filenames

class AudioClient {
  private static instance: AudioClient;
  private openai: OpenAI;
  private logger = new Logger(); // Instantiate logger

  private constructor() {
    // Ensure the OpenAI API key is configured
    if (!process.env.OPENAI_API_KEY) {
      this.logger.log('OPENAI_API_KEY environment variable is not defined');
      throw new Error('OPENAI_API_KEY environment variable is not defined');
    }
    this.openai = new OpenAI(); // Initializes with API key from env automatically
  }

  public static getInstance(): AudioClient {
    if (!AudioClient.instance) {
      AudioClient.instance = new AudioClient();
    }
    return AudioClient.instance;
  }

  /**
   * Generates audio from text using OpenAI's TTS model.
   * @param inputText The text to convert to speech.
   * @param voice The voice to use (e.g., 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral').
   * @param inputText The text to convert to speech.
   * @param instructions Optional instructions for the speech generation.
   * @returns The full path to the generated speech file.
   */
  public async generateAudio(
    inputText: string, // Make inputText required
    instructions?: string
  ): Promise<string> {
    const voice = 'coral'; // Hardcoded voice
    const model = 'gpt-4o-mini-tts'; // Hardcoded model
    const outputFilename = `${nanoid()}.mp3`; // Generate random filename

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
        `Generating audio for text: "${inputText}" using voice: ${voice}, model: ${model}, saving to: ${speechFile}`
      );
      const mp3 = await this.openai.audio.speech.create({
        model: model, // Use hardcoded model
        voice: voice, // Use hardcoded voice
        input: inputText,
        ...(instructions && { instructions }), // Conditionally add instructions
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());

      // Ensure the output directory exists
      await fs.mkdir(outputDirectory, { recursive: true });

      await fs.writeFile(speechFile, buffer);
      this.logger.log(`Audio file saved successfully to: ${speechFile}`);
      return speechFile;
    } catch (error) {
      this.logger.log(`Error generating audio: ${(error as Error).message}`);
      if (error instanceof OpenAI.APIError) {
        this.logger.log(`OpenAI API Error Status: ${error.status}`);
        this.logger.log(`OpenAI API Error Message: ${error.message}`);
        this.logger.log(`OpenAI API Error Code: ${error.code}`);
        this.logger.log(`OpenAI API Error Type: ${error.type}`);
      }
      throw error; // Re-throw the error after logging
    }
  }
}

export default AudioClient;
