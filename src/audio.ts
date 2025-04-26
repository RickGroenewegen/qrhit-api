import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import Logger from './logger'; // Assuming you have a logger like in other classes

class AudioClient {
  private static instance: AudioClient;
  private openai: OpenAI;
  private logger = new Logger(); // Instantiate logger

  private constructor() {
    // Ensure the OpenAI API key is configured
    if (!process.env.OPENAI_API_KEY) {
      this.logger.log('OPENAI_API_KEY environment variable is not defined', 'error');
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
   * @param model The TTS model to use (e.g., 'tts-1', 'tts-1-hd', 'gpt-4o-mini-tts').
   * @param instructions Optional instructions for the speech generation.
   * @param outputDirectory The directory to save the generated speech file. Defaults to './'.
   * @param outputFilename The name for the output MP3 file. Defaults to 'speech.mp3'.
   * @returns The full path to the generated speech file.
   */
  public async generateAudio(
    inputText: string = "Today is a wonderful day to build something people love!",
    voice: OpenAI.Audio.Speech.Voice = "coral",
    model: string = "gpt-4o-mini-tts", // Use a valid model identifier
    instructions?: string,
    outputDirectory: string = './',
    outputFilename: string = 'speech.mp3'
  ): Promise<string> {
    const speechFile = path.resolve(outputDirectory, outputFilename);

    try {
      this.logger.log(`Generating audio for text: "${inputText}" using voice: ${voice}, model: ${model}`);
      const mp3 = await this.openai.audio.speech.create({
        model: model,
        voice: voice,
        input: inputText,
        ...(instructions && { instructions }), // Conditionally add instructions
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());

      // Ensure the output directory exists
      await fs.promises.mkdir(outputDirectory, { recursive: true });

      await fs.promises.writeFile(speechFile, buffer);
      this.logger.log(`Audio file saved successfully to: ${speechFile}`);
      return speechFile;
    } catch (error) {
      this.logger.log(`Error generating audio: ${(error as Error).message}`, 'error');
      if (error instanceof OpenAI.APIError) {
        this.logger.log(`OpenAI API Error Status: ${error.status}`, 'error');
        this.logger.log(`OpenAI API Error Message: ${error.message}`, 'error');
        this.logger.log(`OpenAI API Error Code: ${error.code}`, 'error');
        this.logger.log(`OpenAI API Error Type: ${error.type}`, 'error');
      }
      throw error; // Re-throw the error after logging
    }
  }
}

export default AudioClient;
