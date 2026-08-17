# SmartRecap

SmartRecap turns lecture slides and notes into a structured recap and a short knowledge-check quiz. This repository currently contains the responsive React demonstration frontend.

## Features

- PDF, PPTX, and DOCX upload experience
- Last-Minute Cram and Deep Revision modes
- Transparent processing pipeline
- Structured recap with source citations
- Interactive quiz with explanations
- Accuracy-aware scoring and revision recommendations
- Searchable material history

## Local development

```bash
npm install
npm run dev -- --port 3000
```

Open `http://127.0.0.1:3000`.

## Production build

```bash
npm run build
```

The production files are generated in `dist/`.

## Planned architecture

- React frontend on AWS Amplify Hosting
- Python API on AWS Lambda and API Gateway
- Source files in Amazon S3
- Recap and quiz history in DynamoDB
- OpenAI-compatible AI provider called only from the backend

Never commit API keys, AWS credentials, private keys, or `.env` files.