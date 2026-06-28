#!/usr/bin/env node

import { cleanupSeatingFeedback } from '../gateway/services/seating-feedback.js';

try {
    const result = await cleanupSeatingFeedback();
    console.log(JSON.stringify(result, null, 2));
} catch (error) {
    console.error('[cleanup:feedback] failed:', error?.message || error);
    process.exitCode = 1;
}
