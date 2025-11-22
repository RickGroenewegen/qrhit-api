import OpenAI from 'openai';
import PrismaInstance from './prisma';
import Logger from './logger';
import Cache from './cache';
import { color } from 'console-log-colors';
import fs from 'fs';
import path from 'path';
import cluster from 'cluster';
import Shipping from './shipping';

interface RequiredDataItem {
  name: string;
  description: string;
}

interface Tool {
  name: string;
  requiredData: RequiredDataItem[];
}

interface KnowledgeItem {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  tools?: Tool[];
}

interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class ChatService {
  private openai = new OpenAI({
    apiKey: process.env['OPENAI_TOKEN'],
  });
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();
  private knowledge: KnowledgeItem[] = [];
  private static CACHE_TTL = 3600; // 1 hour

  constructor() {
    this.loadKnowledge();
  }

  private getCacheKey(chatId: number): string {
    return `chat:history:${chatId}`;
  }

  public async invalidateChatCache(chatId: number): Promise<void> {
    await this.cache.del(this.getCacheKey(chatId));
  }

  private loadKnowledge(): void {
    try {
      const appRoot = process.env['APP_ROOT'] || path.join(__dirname, '..');
      const chatJsonPath = path.join(appRoot, '_data', 'chat.json');
      const data = JSON.parse(fs.readFileSync(chatJsonPath, 'utf-8'));
      this.knowledge = data.knowledge;
      if (cluster.isPrimary) {
        this.logger.log(color.green(`Loaded `) + color.white.bold(`${this.knowledge.length}`) + color.green(` knowledge items for chat`));
      }
    } catch (error) {
      this.logger.log(color.red.bold(`Failed to load chat knowledge: ${error}`));
      this.knowledge = [];
    }
  }

  /**
   * Create a new chat session
   */
  public async createChat(email: string): Promise<number> {
    const username = email.split('@')[0];
    const chat = await this.prisma.chat.create({
      data: { email, username },
    });
    return chat.id;
  }

  /**
   * Get existing chat by ID
   */
  public async getChat(chatId: number): Promise<{ id: number; email: string | null; username: string | null; locale: string | null; supportNeeded: boolean; hijacked: boolean } | null> {
    return this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { id: true, email: true, username: true, locale: true, supportNeeded: true, hijacked: true },
    });
  }

  /**
   * Update chat locale
   */
  public async updateChatLocale(chatId: number, locale: string): Promise<void> {
    await this.prisma.chat.update({
      where: { id: chatId },
      data: { locale },
    });
  }

  /**
   * Toggle hijack status
   */
  public async toggleHijack(chatId: number, hijacked: boolean): Promise<void> {
    await this.prisma.chat.update({
      where: { id: chatId },
      data: { hijacked },
    });
  }

  /**
   * Save user message and translate to Dutch (for hijacked mode)
   */
  public async saveUserMessage(chatId: number, content: string): Promise<{ id: number; translatedContent: string | null }> {
    const messageId = await this.saveMessage(chatId, 'user', content);
    const translatedContent = await this.translateContentToDutch(content);
    if (translatedContent) {
      await this.prisma.chatMessage.update({
        where: { id: messageId },
        data: { translatedContent },
      });
    }
    return { id: messageId, translatedContent };
  }

  /**
   * Translate content to Dutch and return the result
   */
  private async translateContentToDutch(content: string): Promise<string | null> {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: 'Translate the following text to Dutch. Return only the translation, nothing else.',
          },
          { role: 'user', content },
        ],
      });
      return response.choices[0]?.message?.content || null;
    } catch (error) {
      this.logger.log(`[Chat] Translation error: ${error}`);
      return null;
    }
  }

  /**
   * Save admin message and translate to user's locale
   */
  public async saveAdminMessage(chatId: number, content: string, targetLocale: string): Promise<{ id: number; translatedContent: string | null }> {
    // Save admin message (content is in Dutch)
    const message = await this.prisma.chatMessage.create({
      data: {
        chatId,
        role: 'admin',
        content, // Dutch content
        translatedContent: content, // Dutch is also the translated content for admin view
      },
    });

    await this.invalidateChatCache(chatId);

    // Translate to user's locale if not Dutch
    let userContent = content;
    if (targetLocale && targetLocale !== 'nl') {
      userContent = await this.translateToLocale(content, targetLocale);
    }

    return { id: message.id, translatedContent: userContent };
  }

  /**
   * Translate content to a specific locale
   */
  public async translateToLocale(content: string, targetLocale: string): Promise<string> {
    const localeNames: { [key: string]: string } = {
      en: 'English',
      de: 'German',
      fr: 'French',
      es: 'Spanish',
      it: 'Italian',
      pt: 'Portuguese',
      pl: 'Polish',
      sv: 'Swedish',
      jp: 'Japanese',
      cn: 'Chinese',
    };

    const targetLang = localeNames[targetLocale] || 'English';

    try {
      const result = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: `Translate the following Dutch text to ${targetLang}. Keep any markdown formatting intact. Only return the translation, nothing else.`,
          },
          {
            role: 'user',
            content,
          },
        ],
      });

      return result.choices[0]?.message?.content || content;
    } catch (error) {
      this.logger.log(color.red.bold(`[translateToLocale] Error: ${error}`));
      return content;
    }
  }

  /**
   * Mark chat as needing support
   */
  public async markSupportNeeded(chatId: number): Promise<void> {
    await this.prisma.chat.update({
      where: { id: chatId },
      data: { supportNeeded: true },
    });
  }

  /**
   * Mark chat as seen by admin
   */
  public async markChatAsSeen(chatId: number): Promise<void> {
    await this.prisma.chat.update({
      where: { id: chatId },
      data: { unseenMessages: false },
    });
  }

  /**
   * Check if chat has messages
   */
  public async chatHasMessages(chatId: number): Promise<boolean> {
    const count = await this.prisma.chatMessage.count({
      where: { chatId },
    });
    return count > 0;
  }

  /**
   * Save a message to the chat history
   */
  public async saveMessage(chatId: number, role: 'user' | 'assistant', content: string): Promise<number> {
    const message = await this.prisma.chatMessage.create({
      data: {
        chatId,
        role,
        content,
      },
    });
    await this.invalidateChatCache(chatId);
    return message.id;
  }

  /**
   * Translate content to Dutch and store it (runs in background)
   */
  public async translateToDutch(messageId: number, content: string): Promise<void> {
    try {
      const result = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: 'Translate the following text to Dutch. Keep any markdown formatting intact. Only return the translation, nothing else.',
          },
          {
            role: 'user',
            content,
          },
        ],
      });

      const translatedContent = result.choices[0]?.message?.content;
      if (translatedContent) {
        await this.prisma.chatMessage.update({
          where: { id: messageId },
          data: { translatedContent },
        });
        this.logger.log(color.green.bold(`[translateToDutch] `) + color.green(`Translated message `) + color.white.bold(`${messageId}`));
      }
    } catch (error) {
      this.logger.log(color.red.bold(`[translateToDutch] Error: ${error}`));
    }
  }

  /**
   * Get chat history (max 25 messages, only visible to user)
   */
  public async getChatHistory(chatId: number): Promise<ChatHistoryMessage[]> {
    const cacheKey = this.getCacheKey(chatId);
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const messages = await this.prisma.chatMessage.findMany({
      where: { chatId, visibleToUser: true },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });

    const result = messages.map((m) => ({
      role: (m.role === 'admin' ? 'assistant' : m.role) as 'user' | 'assistant',
      content: m.content,
    }));

    await this.cache.set(cacheKey, JSON.stringify(result), ChatService.CACHE_TTL);
    return result;
  }

  /**
   * Hide all messages for a chat (soft clear)
   */
  public async clearChatForUser(chatId: number): Promise<void> {
    await this.prisma.chatMessage.updateMany({
      where: { chatId },
      data: { visibleToUser: false },
    });
    await this.invalidateChatCache(chatId);
  }

  /**
   * Get relevant topics using function calling
   */
  public async getTopics(question: string, chatHistory: ChatHistoryMessage[]): Promise<string[]> {
    this.logger.log(color.cyan.bold(`[getTopics] `) + color.cyan(`Question: "`) + color.white.bold(`${question.substring(0, 50)}${question.length > 50 ? '...' : ''}`) + color.cyan(`"`));
    this.logger.log(color.cyan.bold(`[getTopics] `) + color.cyan(`Chat history items: `) + color.white.bold(`${chatHistory.length}`));

    // Build topics summary for function calling
    const topicsSummary = this.knowledge.map((item) => ({
      slug: item.slug,
      title: item.title,
      tags: item.tags.join(', '),
    }));

    const historyContext = chatHistory.length > 0
      ? `\n\nPrevious conversation:\n${chatHistory.map((m) => `${m.role}: ${m.content}`).join('\n')}`
      : '';

    const result = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant for QRSong!, a service that creates QR music game cards from Spotify playlists.
Your job is to identify which knowledge topics are relevant to answer the user's question.
Analyze the question and select the most relevant topics from the available list.
Select 1-5 topics maximum. Only select topics that are directly relevant.
If the question is a greeting or general chat, return an empty array.`,
        },
        {
          role: 'user',
          content: `Available topics:\n${JSON.stringify(topicsSummary, null, 2)}${historyContext}\n\nUser question: ${question}`,
        },
      ],
      function_call: { name: 'selectTopics' },
      functions: [
        {
          name: 'selectTopics',
          description: 'Select relevant knowledge topics to answer the user question',
          parameters: {
            type: 'object',
            properties: {
              slugs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of topic slugs that are relevant to the question',
              },
              reasoning: {
                type: 'string',
                description: 'Brief explanation of why these topics were selected',
              },
            },
            required: ['slugs'],
          },
        },
      ],
    });

    if (result?.choices[0]?.message?.function_call) {
      try {
        const parsed = JSON.parse(result.choices[0].message.function_call.arguments as string);
        this.logger.log(color.green.bold(`[getTopics] `) + color.green(`Selected `) + color.white.bold(`${parsed.slugs?.length || 0}`) + color.green(` topics: `) + color.white.bold(`${(parsed.slugs || []).join(', ')}`));
        if (parsed.reasoning) {
          this.logger.log(color.gray(`[getTopics] Reasoning: ${parsed.reasoning}`));
        }
        return parsed.slugs || [];
      } catch (error) {
        this.logger.log(color.red.bold(`Error parsing topics: ${error}`));
        return [];
      }
    }
    return [];
  }

  /**
   * Get full knowledge items by slugs
   */
  private getKnowledgeBySlug(slugs: string[]): KnowledgeItem[] {
    return this.knowledge.filter((item) => slugs.includes(item.slug));
  }

  /**
   * Extract required data from chat history using AI
   */
  private async extractRequiredData(
    requiredData: RequiredDataItem[],
    chatHistory: ChatHistoryMessage[],
    currentQuestion: string
  ): Promise<{ [key: string]: string | null }> {
    const dataNames = requiredData.map(d => d.name);

    const result = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Extract the following data from the conversation if provided by the user.
Data to extract: ${requiredData.map(d => `${d.name} (${d.description})`).join(', ')}

Return a JSON object with the data names as keys and extracted values (or null if not found).
Only extract data that was clearly provided by the user.`,
        },
        {
          role: 'user',
          content: `Conversation:\n${chatHistory.map(m => `${m.role}: ${m.content}`).join('\n')}\nuser: ${currentQuestion}\n\nExtract: ${dataNames.join(', ')}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    try {
      return JSON.parse(result.choices[0]?.message?.content || '{}');
    } catch {
      return {};
    }
  }

  /**
   * Get shipping status by order number
   */
  public async getShippingStatus(orderNumber: string, email: string): Promise<string> {
    try {
      // Find payment by orderId (the order number users receive in their confirmation email)
      const payment = await this.prisma.payment.findFirst({
        where: { orderId: orderNumber },
        select: {
          paymentId: true,
          email: true,
          shippingStatus: true,
          shippingMessage: true,
          shippingStartDateTime: true,
          shippingDeliveryDateTime: true,
          shippingCode: true,
          printApiStatus: true,
          printApiShipped: true,
        },
      });

      if (!payment) {
        return `Order ${orderNumber} was not found. Please check if the order number is correct.`;
      }

      // Verify email matches
      if (payment.email?.toLowerCase() !== email.toLowerCase()) {
        return `The email address provided does not match the order. Please verify both the order number and email address.`;
      }

      // If no shipping code yet, order might not be shipped
      if (!payment.shippingCode) {
        if (payment.printApiStatus === 'Created' || payment.printApiStatus === 'Processing') {
          return `Order ${orderNumber} is currently being prepared for shipping. It has not been shipped yet.`;
        }
        return `Order ${orderNumber} does not have tracking information available yet.`;
      }

      // Try to get fresh tracking info
      try {
        const shipping = Shipping.getInstance();
        await shipping.getTrackingInfo(payment.paymentId);

        // Refetch updated payment
        const updated = await this.prisma.payment.findUnique({
          where: { paymentId: payment.paymentId },
          select: {
            shippingStatus: true,
            shippingMessage: true,
            shippingStartDateTime: true,
            shippingDeliveryDateTime: true,
          },
        });

        if (updated) {
          let statusInfo = `Order ${orderNumber} status: ${updated.shippingStatus || 'Unknown'}`;
          if (updated.shippingMessage) {
            statusInfo += `\nLatest update: ${updated.shippingMessage}`;
          }
          if (updated.shippingDeliveryDateTime) {
            statusInfo += `\nDelivered on: ${new Date(updated.shippingDeliveryDateTime).toLocaleDateString()}`;
          } else if (updated.shippingStartDateTime) {
            statusInfo += `\nShipped on: ${new Date(updated.shippingStartDateTime).toLocaleDateString()}`;
          }
          return statusInfo;
        }
      } catch (trackingError) {
        // Use cached data if tracking API fails
        this.logger.log(color.yellow(`[getShippingStatus] Tracking API error, using cached data`));
      }

      // Return cached shipping data
      let statusInfo = `Order ${orderNumber} status: ${payment.shippingStatus || 'Shipped'}`;
      if (payment.shippingMessage) {
        statusInfo += `\nLatest update: ${payment.shippingMessage}`;
      }
      return statusInfo;
    } catch (error) {
      this.logger.log(color.red(`[getShippingStatus] Error: ${error}`));
      return `Unable to retrieve shipping status for order ${orderNumber}. Please try again later or contact support.`;
    }
  }

  /**
   * Execute a tool and return the result
   */
  private async executeTool(toolName: string, data: { [key: string]: string }): Promise<string> {
    switch (toolName) {
      case 'getShippingStatus':
        return this.getShippingStatus(data['orderNumber'], data['email']);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  /**
   * Stream answer to a question using relevant knowledge
   */
  public async answerQuestion(
    question: string,
    topicSlugs: string[],
    chatHistory: ChatHistoryMessage[],
    onToken: (token: string) => void
  ): Promise<string> {
    this.logger.log(color.cyan.bold(`[answerQuestion] `) + color.cyan(`Generating answer with `) + color.white.bold(`${topicSlugs.length}`) + color.cyan(` topics and `) + color.white.bold(`${chatHistory.length}`) + color.cyan(` history items`));

    const relevantKnowledge = this.getKnowledgeBySlug(topicSlugs);

    // Check if any knowledge item has tools
    let toolContext = '';
    for (const knowledge of relevantKnowledge) {
      if (knowledge.tools && knowledge.tools.length > 0) {
        for (const tool of knowledge.tools) {
          this.logger.log(color.magenta.bold(`[answerQuestion] `) + color.magenta(`Tool detected: `) + color.white.bold(`${tool.name}`));

          // Extract required data from conversation
          const extractedData = await this.extractRequiredData(
            tool.requiredData,
            chatHistory,
            question
          );

          this.logger.log(color.magenta.bold(`[answerQuestion] `) + color.magenta(`Extracted data: `) + color.white.bold(JSON.stringify(extractedData)));

          // Check if all required data is present
          const missingData = tool.requiredData.filter(
            (rd) => !extractedData[rd.name]
          );

          if (missingData.length > 0) {
            // Missing data - ask user for it
            const missingDescriptions = missingData
              .map((d) => `${d.name} (${d.description})`)
              .join(', ');

            this.logger.log(color.yellow.bold(`[answerQuestion] `) + color.yellow(`Missing data: `) + color.white.bold(missingDescriptions));

            toolContext = `\n\nIMPORTANT: To help the user, you need the following information that they haven't provided yet:\n${missingData.map((d) => `- ${d.name}: ${d.description}`).join('\n')}\n\nPolitely ask the user to provide this information.`;
          } else {
            // All data present - execute tool
            this.logger.log(color.green.bold(`[answerQuestion] `) + color.green(`Executing tool: `) + color.white.bold(`${tool.name}`));

            const toolResult = await this.executeTool(
              tool.name,
              extractedData as { [key: string]: string }
            );

            this.logger.log(color.green.bold(`[answerQuestion] `) + color.green(`Tool result: `) + color.white.bold(toolResult.substring(0, 100)));

            toolContext = `\n\nTOOL RESULT (use this information to answer the user):\n${toolResult}`;
          }
        }
      }
    }

    const knowledgeContext = relevantKnowledge.length > 0
      ? `\n\nRelevant information:\n${relevantKnowledge.map((k) => `**${k.title}**\n${k.description}`).join('\n\n')}`
      : '';

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are a friendly and helpful customer support assistant for QRSong! - a service that creates QR music game cards from Spotify playlists.

IMPORTANT INSTRUCTIONS:
- Answer the user's question using ONLY the provided knowledge context
- If the question cannot be answered with the provided context, politely say you don't have that information and suggest contacting support at info@qrsong.io
- ALWAYS respond in the SAME LANGUAGE the user asked their question in
- Be concise but helpful
- Use markdown formatting for better readability
- Be friendly and conversational
- If the user greets you, greet them back warmly and ask how you can help
- SUPPORT BUTTON: If the user appears frustrated, confused, repeats questions, expresses dissatisfaction, seems unhappy with answers, asks about something you cannot help with, or generally is not getting their question answered properly, add the marker [SHOW_SUPPORT_BUTTON] at the END of your response. This shows them a button to request human support.

${knowledgeContext}${toolContext}`,
      },
    ];

    // Add chat history
    for (const msg of chatHistory) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    // Add current question
    messages.push({
      role: 'user',
      content: question,
    });

    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      stream: true,
      messages,
    });

    let fullResponse = '';

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullResponse += content;
        onToken(content);
      }
    }

    return fullResponse;
  }

  /**
   * Main entry point: process a user question with streaming response
   */
  public async processQuestion(
    chatId: number,
    question: string,
    onToken: (token: string) => void,
    onSearching?: () => void
  ): Promise<void> {
    // Save user message and trigger async translation
    const userMessageId = await this.saveMessage(chatId, 'user', question);
    this.translateToDutch(userMessageId, question);

    // Get chat history
    const history = await this.getChatHistory(chatId);
    // Remove the just-added question from history for context
    const previousHistory = history.slice(0, -1);

    // Notify that we're searching
    if (onSearching) {
      onSearching();
    }

    // Get relevant topics
    const topics = await this.getTopics(question, previousHistory);

    // Generate and stream answer
    const answer = await this.answerQuestion(question, topics, previousHistory, onToken);

    // Save assistant response and trigger async translation
    const messageId = await this.saveMessage(chatId, 'assistant', answer);

    // Translate to Dutch in background (don't await)
    this.translateToDutch(messageId, answer);
  }
}
