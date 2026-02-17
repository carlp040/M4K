#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="${1:-m4k}"
NAMESPACE="${2:-m4k-pipeline}"
IMAGE_TAG="${3:-k8s-v8}"
IMAGE="first-pipeline:${IMAGE_TAG}"

echo "Building image ${IMAGE} ..."
docker build -t "${IMAGE}" .

if command -v kind >/dev/null 2>&1; then
  echo "Loading image via kind ..."
  kind load docker-image "${IMAGE}" --name "${CLUSTER_NAME}"
else
  echo "kind not found in PATH; please load image manually for your cluster runtime."
  exit 1
fi

echo "Applying Kubernetes manifests ..."
kubectl apply -k k8s

echo "Pinning deployment image to ${IMAGE} ..."
kubectl set image deployment/first-pipeline first-pipeline="${IMAGE}" -n "${NAMESPACE}"

echo "Waiting for rollouts ..."
kubectl rollout status deployment/first-pipeline -n "${NAMESPACE}"
kubectl rollout status deployment/frontend -n "${NAMESPACE}"
kubectl rollout status statefulset/mongo -n "${NAMESPACE}"

echo "Current resources:"
kubectl get deploy,sts,svc,pods -n "${NAMESPACE}" -o wide
