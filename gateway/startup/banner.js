export function logStartupBanner(config, logger = console) {
    logger.log(`
============================================================
  ICeCream Gateway Server

  Local:   http://localhost:${config.port}
  Status:  Ready
============================================================
`);
    logger.log('[INFO] Intent Classifier:', process.env.INTENT_CLASSIFIER_ENABLED === 'true' ? 'Enabled' : 'Disabled');
    logger.log('[INFO] DeepSeek API:', process.env.DEEPSEEK_API_KEY ? 'Configured' : 'Not configured');
    logger.log('[INFO] SiliconFlow API:', process.env.SILICONFLOW_API_KEY ? 'Configured' : 'Not configured');
}
