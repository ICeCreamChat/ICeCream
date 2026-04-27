
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs';

dotenv.config();

const apiKey = process.env.SILICONFLOW_API_KEY;
const baseUrl = process.env.SILICONFLOW_API_BASE || 'https://api.siliconflow.cn/v1';

console.log('Using Key:', apiKey ? 'Configured' : 'None');
console.log('Base URL:', baseUrl);

async function listModels() {
    try {
        const response = await fetch(`${baseUrl}/models`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });

        if (!response.ok) {
            console.error('Error:', response.status, await response.text());
            return;
        }

        const data = await response.json();
        fs.writeFileSync('models.json', JSON.stringify(data, null, 2));
        console.log('--- MODELS SAVED TO models.json ---');
    } catch (e) {
        console.error(e);
    }
}

listModels();
