export function logStartupBanner(config, logger = console) {
    const host = config.host || '127.0.0.1';
    const localHost = host === '0.0.0.0' ? 'localhost' : host;
    logger.log(`
============================================================
  ICeCream Gateway Server

  Local:   http://${localHost}:${config.port}
  Bind:    ${host}:${config.port}
  Status:  Ready
============================================================
`);
    logger.log('[INFO] Intent Classifier:', process.env.INTENT_CLASSIFIER_ENABLED === 'true' ? 'Enabled' : 'Disabled');
    logger.log('[INFO] DeepSeek API:', process.env.DEEPSEEK_API_KEY ? 'Configured' : 'Not configured');
    logger.log('[INFO] SiliconFlow API:', process.env.SILICONFLOW_API_KEY ? 'Configured' : 'Not configured');
}
