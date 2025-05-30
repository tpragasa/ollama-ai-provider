#! /usr/bin/env -S pnpm tsx

import { generateObject } from 'ai'
import { ollama } from 'ollama-ai-provider'
import { z } from 'zod'

import { buildProgram } from '../tools/command'

async function main(model: Parameters<typeof ollama>[0]) {
  const result = await generateObject({
    model: ollama(model, { structuredOutputs: true }),
    output: 'array',
    prompt:
      'Generate 3 character descriptions for a fantasy role playing game.',
    schema: z.object({
      characters: z.array(
        z.object({
          class: z
            .string()
            .describe('Character class, e.g. warrior, mage, or thief.'),
          description: z.string(),
          name: z.string(),
        }),
      ),
    }),
  })

  console.log(JSON.stringify(result.object, null, 2))
  console.log()
  console.log('Token usage:', result.usage)
  console.log('Finish reason:', result.finishReason)
}

buildProgram('llama3.1', main).catch(console.error)
