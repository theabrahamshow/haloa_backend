const express = require('express')
const rateLimit = require('express-rate-limit')
const crypto = require('crypto')
const request = require('request')
require('path')
require('assert')
const https = require('https')
require('dotenv').config()
const app = express()

// Change the port if you need it.
const port = 10000

const chatUrl = 'https://api.openai.com/v1/chat/completions'
const dalleUrl = 'https://api.openai.com/v1/images/generations'
const rateLimitErrorCode = 'rate_limit_exceeded'
const wrapFastAppIdentifier = 'wrapfast'

// Environment variables
const apiKey = process.env.API_KEY
const AUTH_SECRET_KEY = process.env.AUTH_SECRET_KEY
const HMAC_SECRET_KEY = process.env.HMAC_SECRET_KEY
const AUTH_LIMIT = process.env.AUTH_LIMIT
const PROMPT_LIMIT = process.env.PROMPT_LIMIT
const VISION_MAX_TOKENS = process.env.VISION_MAX_TOKENS
const telegramBotKey = process.env.TELEGRAM_BOT_KEY
const channelId = process.env.TELEGRAM_CHANNEL_ID

if (!apiKey) {
  console.error('API key not found')
  process.exit(1)
}

if (!HMAC_SECRET_KEY) {
  console.error('HMAC secret key not found')
  process.exit(1)
}

// Rate limits each 5 minutes. Tweak it if you need.
// These limits prevents abusing of the OpenAI requests.
const promptLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: PROMPT_LIMIT
})

const authtLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: AUTH_LIMIT
})

// POST endpoints to send requests to OpenAI APIs
app.use('/vision', promptLimiter)
app.use('/chatgpt', promptLimiter)
app.use('/dalle', promptLimiter)
// GET endpoint to send de hmac secret key
app.use('/auth', authtLimiter)

// Enable Trust Proxy in Express
app.set('trust proxy', true)

// Verify the HMAC secret keys
const verifyHmacSignature = (req, res, next) => {
  const signature = req.headers['x-signature']

  const dataToSign = req.originalUrl
  const hmac = crypto.createHmac('sha256', req.path === '/auth' ? AUTH_SECRET_KEY : HMAC_SECRET_KEY)
  hmac.update(dataToSign)
  const digest = hmac.digest('hex')

  if (signature === digest) {
    next()
  } else {
    return res.status(401).send('Invalid signature')
  }
}

app.use(express.json({ limit: '10mb' }))

app.use(verifyHmacSignature)

// GPT-4 Vision Endpoint
// It expects a JSON with an image property
// {image: String}
// You can change it or add more properties to handle your special cases.
app.post('/vision', async (req, res) => {
  try {
    let IMAGE = ''
    const appIdentifier = req.get('X-App-Identifier')
    let prompt = ''

    // You can make custom logic here to use this endpoint for several apps and handling what prompts
    // you send to OpenAI's API
    if (appIdentifier === wrapFastAppIdentifier) {
      prompt = buildWrapFastPrompt(req.body)
    }

    IMAGE = req.body.image

    if (!IMAGE) {
      return res.status(400).json({ error: 'Missing "image" in request body' })
    }

    const payload = {
      model: 'gpt-4-vision-preview',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: prompt
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${IMAGE}`,
                detail: 'low'
              }
            }
          ]
        }
      ],
      max_tokens: VISION_MAX_TOKENS
    }

    try {
      console.log(`\n📸 Requesting image analysis with prompt: ${prompt}`)

      const jsonResponse = await postVisionApi(payload)
      if (jsonResponse.error) {
        return res.status(500).json({ error: jsonResponse.error })
      }

      res.json(jsonResponse)
    } catch (error) {
      if (error === rateLimitErrorCode) {
        res.status(400).json({ error: 'Error response from OpenAI API', details: `Error message: ${error.message} with code: ${error.code}` })
      }

      res.status(500).json({ error: 'Error', details: error.message })
    }
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Request to OpenAI failed', details: error.message })
  }
})

// ChatGPT Endpoint
// It expects a JSON with a prompt property
// {prompt: String}
// You can change it or add more properties to handle your special cases.
// In this example we use the model gpt-4. You can use the model you need.
// Check OpenAI documentation:
// https://platform.openai.com/docs/guides/text-generation
app.post('/chatgpt', async (req, res) => {
  try {
    const prompt = req.body.prompt

    const payload = {
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          // You can set here instructions of how you wish the assistant to behave.
          content: 'You are a helpful assistant.'
        },
        {
          role: 'user',
          // Here you pass the user's prompt to ChatGPT.
          content: prompt
        }
      ]
    }

    try {
      console.log(`\n💬 Requesting ChatGPT prompt: ${prompt}`)

      const jsonResponse = await postChatgptApi(payload)
      if (jsonResponse.error) {
        return res.status(500).json({ error: jsonResponse.error })
      }

      res.json(jsonResponse)
    } catch (error) {
      if (error === rateLimitErrorCode) {
        res.status(400).json({ error: 'Error response from OpenAI API', details: `Error message: ${error.message} with code: ${error.code}` })
      }

      res.status(500).json({ error: 'Error', details: error.message })
    }
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Request to OpenAI failed', details: error.message })
  }
})

// DALL·E Endpoint
// It expects a JSON with a prompt property
// {prompt: String}
// You can change it or add more properties to handle your special cases.
// Check OpenAI documentation:
// https://platform.openai.com/docs/guides/images
app.post('/dalle', async (req, res) => {
  try {
    const imagePrompt = req.body.prompt

    const payload = {
      model: 'dall-e-3',
      prompt: imagePrompt,
      n: 1,
      size: '1024x1024'
    }

    try {
      console.log(`\n🏞️ Requesting image generation to DALL·E with prompt: ${imagePrompt}`)

      const imageURL = await postDalleApi(payload)
      if (imageURL.error) {
        return res.status(500).json({ error: imageURL.error })
      }

      res.json(imageURL)
    } catch (error) {
      if (error === rateLimitErrorCode) {
        res.status(400).json({ error: 'Error response from OpenAI API', details: `Error message: ${error.message} with code: ${error.code}` })
      }

      res.status(500).json({ error: 'Error', details: error.message })
    }
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Request to OpenAI failed', details: error.message })
  }
})

// Authentication endpoint for the mobile apps.
// They send the sercret key.
// If verified, we send back the HMAC key that the app should save to make requests to the other endpoints.
app.get('/auth', (req, res) => {
  const responseData = { value: HMAC_SECRET_KEY }
  res.send(responseData)
  console.log('Authorization request received')
  console.log(`[${new Date().toISOString()}] Request received from ${req.ip} for ${req.originalUrl}`)
})

async function postVisionApi (payload) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }

  return new Promise((resolve, reject) => {
    request.post({
      url: chatUrl,
      headers,
      json: payload
    }, (error, response, body) => {
      if (error) {
        console.error('Error:', error)
        return reject(error)
      } else {
        if (response) {
          console.log(`ℹ️ Remaing requests for API KEY: ${response.headers['x-ratelimit-remaining-requests']}`)
          console.log(`⏰ Remaing time until rate limit resets for API KEY: ${response.headers['x-ratelimit-reset-requests']}`)

          // Use the commented code to send alerts over Telegram when the API rate limit exceeded.

          // if (response.headers['x-ratelimit-remaining-requests']) {
          //   const remainingRequests = response.headers['x-ratelimit-remaining-requests']
          //   let telegramMessage

          //   if (remainingRequests === 0) {
          //     telegramMessage = `🚨 ALERT: OpenAI API Key doesn't have enough requests available.`
          //     sendTelegram(telegramMessage)
          //   } else if (remainingRequests === 10) {
          //     telegramMessage = `☣️ WARNING: OpenAI API Key has ${remainingRequests} remaining requests.`
          //     sendTelegram(telegramMessage)
          //   }
          // }
        }

        try {
          console.log(body)
          console.log(`Image result received and consumed total tokens: ${body.usage.total_tokens}`)
        } catch (error) {
          console.log('The JSON response does not contain total_tokens property. Another response?')
          // If it is not a proper response, check if it is an error response like this
          // {
          // error: {
          //   message: 'Your input image may contain content that is not allowed by our safety system.',
          //   type: 'invalid_request_error',
          //   param: null,
          //   code: 'content_policy_violation'
          // }
          // }

          try {
            if (body.error) {
              console.log('Error response from OpenAI API: ', body.error.message)
              const errorCode = body.error.code
              console.log('With code: ', errorCode)

              return reject(new Error(errorCode))
            } else {
              return reject(new Error(body))
            }
          } catch (error) {
            console.error('Error accessing properties of error object from OpenAI API: ', error)
            return reject(error)
          }
        }

        try {
          const parsedMarkDownString = removeMarkdownJsonSyntax(body.choices[0].message.content)
          const jsonResponse = JSON.parse(parsedMarkDownString)
          console.log(jsonResponse)
          resolve(jsonResponse)
        } catch (e) {
          console.log(body)

          try {
            console.log(body.choices[0])
          } catch {
            console.log('There is no choices property in the object response from OpenAI')
          }
          console.error('Error parsing JSON:', e)
          reject(e)
        }
      }
    })
  })
}

async function postChatgptApi (payload) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }

  return new Promise((resolve, reject) => {
    request.post({
      url: chatUrl,
      headers,
      json: payload
    }, (error, response, body) => {
      if (error) {
        console.error('Error:', error)
        return reject(error)
      } else {
        if (response) {
          console.log(`ℹ️ Remaing requests for API KEY: ${response.headers['x-ratelimit-remaining-requests']}`)
          console.log(`⏰ Remaing time until rate limit resets for API KEY: ${response.headers['x-ratelimit-reset-requests']}`)

          // Use the commented code to send alerts over Telegram when the API rate limit exceeded.

          // if (response.headers['x-ratelimit-remaining-requests']) {
          //   const remainingRequests = response.headers['x-ratelimit-remaining-requests']
          //   let telegramMessage

          //   if (remainingRequests === 0) {
          //     telegramMessage = `🚨 ALERT: OpenAI API Key doesn't have enough requests available.`
          //     sendTelegram(telegramMessage)
          //   } else if (remainingRequests === 10) {
          //     telegramMessage = `☣️ WARNING: OpenAI API Key has ${remainingRequests} remaining requests.`
          //     sendTelegram(telegramMessage)
          //   }
          // }
        }

        try {
          // Uncomment for debug API response
          // console.log(body)
          console.log(`ChatGPT response received and consumed total tokens: ${body.usage.total_tokens}`)
        } catch (error) {
          console.log('The JSON response does not contain total_tokens property. Another response?')
          // If it is not a proper response, check if it is an error response like this
          // {
          // error: {
          //   message: 'Your input image may contain content that is not allowed by our safety system.',
          //   type: 'invalid_request_error',
          //   param: null,
          //   code: 'content_policy_violation'
          // }
          // }

          try {
            if (body.error) {
              console.log('Error response from OpenAI API: ', body.error.message)
              const errorCode = body.error.code
              console.log('With code: ', errorCode)

              return reject(new Error(errorCode))
            } else {
              return reject(new Error(body))
            }
          } catch (error) {
            console.error('Error accessing properties of error object from OpenAI API: ', error)
            return reject(error)
          }
        }

        try {
          const chatgptResponse = {
            message: body.choices[0].message.content
          }
          console.log(chatgptResponse)
          resolve(chatgptResponse)
        } catch (e) {
          console.log(body)

          try {
            console.log(body.choices[0])
          } catch {
            console.log('There is no choices property in the object response from OpenAI')
          }
          console.error('Error parsing JSON:', e)
          reject(e)
        }
      }
    })
  })
}

async function postDalleApi (payload) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }

  return new Promise((resolve, reject) => {
    request.post({
      url: dalleUrl,
      headers,
      json: payload
    }, (error, response, body) => {
      if (error) {
        console.error('Error:', error)
        return reject(error)
      } else {
        try {
          if (body.error) {
            console.log('Error response from OpenAI API: ', body.error.message)
            const errorCode = body.error.code
            console.log('With code: ', errorCode)

            return reject(new Error(errorCode))
          }
        } catch (error) {
          console.error('Error accessing properties of error object from OpenAI API: ', error)
          return reject(error)
        }

        try {
          const dalleResponse = {
            imageUrl: body.data[0].url
          }
          console.log(dalleResponse)
          resolve(dalleResponse)
        } catch (e) {
          console.log(body)
          reject(e)
        }
      }
    })
  })
}

// Send from the app a JSON with the properties you need. In this example we send:
// {image: String,
// language: String}
// -Image: to send to the Vision endpoint.
// -Language: to pass the parameter to the prompt and ask GPT answer in that language, configured in the app.
function buildWrapFastPrompt (body) {
  return `Based on the photo of a meal provided, analyze it as if you were a nutritionist and calculate the total calories, calories per 100 grams, carbs, proteins and fats. Name the meal in ${body.language}. Please, always return only a JSON object with the following properties: 'name', 'total_calories_estimation': INT, 'calories_100_grams': INT, 'carbs': INT, 'proteins': INT, 'fats': INT.`
}

function removeMarkdownJsonSyntax (str) {
  return str.replace(/^```json\n?/, '').replace(/```$/, '')
}

function sendTelegram (message) {
  const encodedText = encodeURIComponent(message)
  const telegramUrl = `https://api.telegram.org/bot${telegramBotKey}/sendMessage?chat_id=${channelId}&text=${encodedText}`

  https.get(telegramUrl, (tgRes) => {
    console.log('🕊️ Message sent to Telegram Channel', tgRes.statusCode)
  }).on('error', (e) => {
    console.error(`Error sending message to Telegram: ${e.message}`)
  })
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})
