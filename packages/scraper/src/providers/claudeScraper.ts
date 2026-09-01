import puppeteer, { Browser, Page } from 'puppeteer';
import { ConversationLink, ConversationData } from '../types';
import { logger } from '../utils/logger';

export class ClaudeScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;

    async initialize(headless: boolean = true) {
        try {
            this.browser = await puppeteer.launch({
            headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
            });
            
            // Get the existing page instead of creating a new one
            const pages = await this.browser.pages();
            this.page = pages[0]; // Use the first page that already exists

            // If no pages exist (shouldn't happen), create one
            if (!this.page) {
                this.page = await this.browser.newPage();
            }
        
            // Set viewport and user agent
            await this.page.setViewport({ width: 1920, height: 1080 });
            await this.page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            );
            
            logger.info('Browser initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize browser:', error);
            throw error;
        }
    }

    async setCookies(cookies: any[]) {
        if (!this.page) throw new Error('Page not initialized');
        
        // Set cookies for claude.ai domain
        const claudeCookies = cookies.map(cookie => ({
        ...cookie,
        domain: '.claude.ai'
        }));
        
        await this.page.setCookie(...claudeCookies);
        logger.info('Cookies set successfully');
    }

    async navigateToProject(projectUrl: string): Promise<boolean> {
        if (!this.page) throw new Error('Page not initialized');
        
        try {
        await this.page.goto(projectUrl, { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        // Wait for project page to load
        await this.page.waitForSelector('[data-testid*="conversation"], main', {
            timeout: 10000
        });
        
        logger.info(`Navigated to project: ${projectUrl}`);
        return true;
        } catch (error) {
        logger.error('Failed to navigate to project:', error);
        return false;
        }
    }

    async getConversationList(): Promise<ConversationLink[]> {
        if (!this.page) throw new Error('Page not initialized');
        
        const conversations: ConversationLink[] = [];
        
        try {
            // Don't navigate anywhere - just work with current page
            const currentUrl = this.page.url();
            logger.info(`Current URL: ${currentUrl}`);
            
            if (!currentUrl.includes('claude.ai')) {
            logger.warn('Not on Claude.ai - cannot get conversations');
            return conversations;
            }
            
            // Just try to find links on current page without any navigation
            const links = await this.page.evaluate(() => {
            const elements = document.querySelectorAll<HTMLAnchorElement>('a[href*="/chat/"]');
            return Array.from(elements).map((el: HTMLAnchorElement) => {
                const href = el.getAttribute('href');
                const text = el.textContent?.trim();
                
                const match = href?.match(/\/chat\/([a-f0-9-]+)/);
                const id = match ? match[1] : '';
                
                return {
                id,
                url: href ? `https://claude.ai${href}` : '',
                title: text || 'Untitled Conversation'
                };
            });
            });
            
            conversations.push(...links);
            logger.info(`Found ${conversations.length} conversations`);
            
        } catch (error) {
            logger.error('Failed to get conversation list:', error);
        }
        
        return conversations;
    }

    async captureConversation(url: string): Promise<ConversationData | null> {
        if (!this.page) throw new Error('Page not initialized');
        
        try {
        await this.page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Wait for messages to load
        await this.page.waitForSelector('[data-testid*="message"], .prose', {
            timeout: 10000
        });
        
        // Scroll to load all messages
        await this.autoScroll(this.page);
        
        // Extract messages
        const messages = await this.page.evaluate(() => {
            const msgs: any[] = [];
            
            // Try multiple selectors for messages
            const messageElements = document.querySelectorAll(
            '[data-testid*="message"], .prose, [class*="message"]'
            );
            
            messageElements.forEach(el => {
            const text = el.textContent?.trim();
            if (!text || text.length < 2) return;
            
            // Determine role
            const isUser = 
                el.getAttribute('data-testid')?.includes('user') ||
                el.querySelector('button[aria-label*="Edit"]') !== null;
            
            msgs.push({
                role: isUser ? 'user' : 'assistant',
                content: text,
                timestamp: new Date().toISOString()
            });
            });
            
            return msgs;
        });
        
        // Extract conversation ID from URL
        const idMatch = url.match(/\/chat\/([a-f0-9-]+)/);
        const id = idMatch ? idMatch[1] : `conv_${Date.now()}`;
        
        logger.info(`Captured ${messages.length} messages from ${url}`);
        
        return {
            id,
            url,
            messages,
            metadata: {
            createdAt: new Date().toISOString(),
            messageCount: messages.length
            }
        };
      
        } catch (error) {
        logger.error(`Failed to capture conversation ${url}:`, error);
        return null;
        }
    }

    private async autoScroll(page: Page) {
        await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;
            
            if (totalHeight >= scrollHeight) {
                clearInterval(timer);
                resolve();
            }
            }, 100);
        });
        });
    }

    async cleanup() {
        if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
        logger.info('Browser closed');
        }
    }
}