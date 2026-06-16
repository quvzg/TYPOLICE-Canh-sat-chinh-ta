# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM base AS builder
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache curl gzip \
  && mkdir -p /app/tessdata \
  && curl -fsSL https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz | gzip -dc > /app/tessdata/eng.traineddata \
  && curl -fsSL https://cdn.jsdelivr.net/npm/@tesseract.js-data/vie/4.0.0/vie.traineddata.gz | gzip -dc > /app/tessdata/vie.traineddata \
  && apk del curl

ARG AI_GATEWAY_BASE_URL=
ARG AI_GATEWAY_API_KEY=
ARG MINIMAX_API_KEY=
ARG QWEN_API_KEY=
ARG GEMMA_API_KEY=
ARG GEMINI_API_KEY=
ARG QWEN_BASE_URL=
ARG MINIMAX_BASE_URL=
ARG GEMMA_BASE_URL=
ARG GEMINI_BASE_URL=
ARG MODEL_ID_QWEN=
ARG MODEL_ID_MINIMAX=
ARG MODEL_ID_GEMMA=
ARG MODEL_ID_GEMINI=gemini-2.5-flash-lite
ARG MODEL_CAPTION_QA=qwen
ARG MODEL_VERIFY=minimax
ARG MODEL_IMAGE_QA=gemma
ARG MODEL_REPORT=minimax

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    AI_GATEWAY_BASE_URL=$AI_GATEWAY_BASE_URL \
    AI_GATEWAY_API_KEY=$AI_GATEWAY_API_KEY \
    MINIMAX_API_KEY=$MINIMAX_API_KEY \
    QWEN_API_KEY=$QWEN_API_KEY \
    GEMMA_API_KEY=$GEMMA_API_KEY \
    GEMINI_API_KEY=$GEMINI_API_KEY \
    QWEN_BASE_URL=$QWEN_BASE_URL \
    MINIMAX_BASE_URL=$MINIMAX_BASE_URL \
    GEMMA_BASE_URL=$GEMMA_BASE_URL \
    GEMINI_BASE_URL=$GEMINI_BASE_URL \
    MODEL_ID_QWEN=$MODEL_ID_QWEN \
    MODEL_ID_MINIMAX=$MODEL_ID_MINIMAX \
    MODEL_ID_GEMMA=$MODEL_ID_GEMMA \
    MODEL_ID_GEMINI=$MODEL_ID_GEMINI \
    MODEL_CAPTION_QA=$MODEL_CAPTION_QA \
    MODEL_VERIFY=$MODEL_VERIFY \
    MODEL_IMAGE_QA=$MODEL_IMAGE_QA \
    MODEL_REPORT=$MODEL_REPORT

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/brand_guidelines ./brand_guidelines
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules

RUN mkdir -p /app/storage \
  && chown -R nextjs:nodejs /app/storage /app/brand_guidelines

USER nextjs

EXPOSE 8080
VOLUME ["/app/storage", "/app/brand_guidelines"]

CMD ["node", "server.js"]
