# Kubernetes Deploy

This folder contains manifests for Bronze, Silver, Gold and Diamond targets:
- `Deployment` + `Service` for backend (`first-pipeline`)
- `Deployment` + `Service` for frontend proxy (`frontend`)
- `StatefulSet` + headless `Service` for MongoDB (`mongo`)
- `Secret` for Mongo credentials/URL (`app-secrets`)
- `ConfigMap` for nginx config (`frontend-nginx-config`)
- `Ingress` and `HPA`
- `Namespace` and `Kustomization`

## Fastest deploy (recommended)
Use the script that builds image, loads it into kind, applies manifests and waits for rollout.

Windows PowerShell:
```powershell
./scripts/deploy-k8s.ps1
```

Linux/macOS:
```bash
./scripts/deploy-k8s.sh
```

## Manual deploy
```bash
docker build -t first-pipeline:k8s-vX .
kind load docker-image first-pipeline:k8s-vX --name m4k
kubectl apply -k k8s
kubectl set image deployment/first-pipeline first-pipeline=first-pipeline:k8s-vX -n m4k-pipeline
kubectl rollout status deployment/first-pipeline -n m4k-pipeline
kubectl rollout status deployment/frontend -n m4k-pipeline
kubectl rollout status statefulset/mongo -n m4k-pipeline
```

## Demo checks
```bash
kubectl get deploy,sts,svc,pods -n m4k-pipeline -o wide
kubectl port-forward svc/frontend 8080:80 -n m4k-pipeline
curl http://localhost:8080/status
curl http://localhost:8080/health
curl http://localhost:8080/metrics
curl http://localhost:8080/db-status
curl http://localhost:8080/k8s
```

## Notes
- For this hackathon, `Secret` uses plaintext values in git for demo speed. In production, use external secret management.
- `Ingress` requires an ingress controller (for example `ingress-nginx`).
- `HPA` requires metrics server.
