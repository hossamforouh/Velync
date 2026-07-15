const { GoogleGenAI, Type } = require('@google/genai');
const logger = require('../../core/logger');
const config = require('../../core/config');

// Initialize the Google Gen AI client using Vertex AI.
// This allows Cloud Run to use its default service account (ADC) without needing a GEMINI_API_KEY.
// Project resolves from GOOGLE_CLOUD_PROJECT (config.firebase.projectId) so this
// targets whichever GCP project the backend is actually running in — staging vs
// production — instead of being hardcoded to one. Falls back to the literal
// 'velync' only if that env var isn't set (preserves prior behavior on any
// deploy target that hasn't had GOOGLE_CLOUD_PROJECT added to it yet).
const ai = new GoogleGenAI({ vertexai: true, project: config.firebase.projectId || 'velync', location: 'us-central1' });

/**
 * Suggests field mappings between a source schema and a destination schema using Gemini.
 * @param {Object} sourceSchema - The schema of the source platform.
 * @param {Object} destSchema - The schema of the destination platform.
 * @returns {Promise<Object>} - An object containing a "suggestions" array.
 */
async function suggestMappings(sourceSchema, destSchema) {
  try {
    const prompt = `You are an intelligent data mapping assistant for Velync, a SaaS integration platform.
Your task is to map fields from a source application to a destination application based on their semantic meaning, data types, and logical relationship.

Source Schema:
${JSON.stringify(sourceSchema, null, 2)}

Destination Schema:
${JSON.stringify(destSchema, null, 2)}

Instructions:
1. Analyze the fields and their types from both schemas.
2. Provide a list of mapping suggestions.
3. Each suggestion must include the source field key, destination field key, confidence score (0.0 to 1.0), and a short 1-sentence reasoning.
4. Only map fields if you have a reasonable confidence (>= 0.5) that they correspond logically.
5. Do NOT force a mapping. If a destination field lacks a logical source, leave it unmapped (do not include it in the array).
6. Pay close attention to field types. For example, a source "title" logically maps to a destination "title", "rich_text", or "text".`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  sourceField: {
                    type: Type.STRING,
                    description: "The key of the field from the Source Schema."
                  },
                  destField: {
                    type: Type.STRING,
                    description: "The key of the field from the Destination Schema."
                  },
                  confidence: {
                    type: Type.NUMBER,
                    description: "A number between 0.0 and 1.0 representing your confidence in this mapping."
                  },
                  reasoning: {
                    type: Type.STRING,
                    description: "A brief, 1 sentence explanation of why this mapping is logically sound."
                  }
                },
                required: ["sourceField", "destField", "confidence", "reasoning"]
              }
            }
          },
          required: ["suggestions"]
        }
      }
    });

    const data = JSON.parse(response.text);
    return data;
  } catch (error) {
    logger.error('mapping-suggester', 'LLM mapping suggestion failed', { error: error.message });
    throw error;
  }
}

module.exports = { suggestMappings };
