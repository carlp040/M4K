# First Pipeline Challenge

![CI/CD Pipeline](https://github.com/YOUR_USERNAME/YOUR_REPO/actions/workflows/pipeline.yml/badge.svg)

Live deployment: [YOUR_DEPLOYED_URL](https://YOUR_DEPLOYED_URL)

## About
Week 4 Boiler Room Hackathon - CI/CD pipeline with GitHub Actions, Docker, Trivy and deployment.

## Endpoints
- `GET /` -> challenge welcome text
- `GET /status` -> basic status + timestamp
- `GET /health` -> health check for monitoring

## Local run
```bash
npm install
npm test
npm start
```

## Docker
```bash
docker build -t first-pipeline .
docker run -p 3000:3000 first-pipeline
curl http://localhost:3000/status
```

## CI/CD Architecture
```text
Push/PR -> GitHub Actions -> npm test -> Docker build -> Trivy scan -> Deploy
```

## Security scanning
Trivy runs in CI on each push/PR. The workflow uploads results as SARIF to GitHub Security tab.

## Deployment (Render example)
1. Create a Render Web Service from this repo.
2. Build command: `npm install`
3. Start command: `npm start`
4. Add Render Deploy Hook URL as GitHub secret: `RENDER_DEPLOY_HOOK_URL`

When `RENDER_DEPLOY_HOOK_URL` is set, deployment is triggered automatically from CI on `main`.
