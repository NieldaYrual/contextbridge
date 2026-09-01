export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    retryableErrors?: string[];
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    retryableErrors = ['PGRST301', '57014', '53300', '08006']
  } = options;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isRetryable = retryableErrors.some(code => 
        error?.code === code || 
        error?.message?.includes(code) ||
        error?.message?.includes('timeout') ||
        error?.message?.includes('connection')
      );

      const isLastAttempt = attempt === maxRetries - 1;

      if (!isRetryable || isLastAttempt) {
        throw error;
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      console.log(`⚠️  Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms due to:`, error.message);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Unexpected: retry loop completed without return or throw');
}