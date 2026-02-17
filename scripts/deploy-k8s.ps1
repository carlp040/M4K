param(
  [string]$ClusterName = "m4k",
  [string]$Namespace = "m4k-pipeline",
  [string]$ImageTag = "k8s-v8"
)

$ErrorActionPreference = "Stop"
$image = "first-pipeline:$ImageTag"

Write-Host "Building image $image ..."
docker build -t $image .

$kindCmd = Get-Command kind -ErrorAction SilentlyContinue
if ($kindCmd) {
  Write-Host "Loading image via kind ..."
  kind load docker-image $image --name $ClusterName
} else {
  Write-Host "kind not found in PATH, loading image via node container ..."
  cmd /c "docker save $image | docker exec -i $ClusterName-control-plane ctr -n k8s.io images import -"
}

Write-Host "Applying Kubernetes manifests ..."
kubectl apply -k k8s

Write-Host "Pinning deployment image to $image ..."
kubectl set image deployment/first-pipeline first-pipeline=$image -n $Namespace

Write-Host "Waiting for rollouts ..."
kubectl rollout status deployment/first-pipeline -n $Namespace
kubectl rollout status deployment/frontend -n $Namespace
kubectl rollout status statefulset/mongo -n $Namespace

Write-Host "Current resources:"
kubectl get deploy,sts,svc,pods -n $Namespace -o wide
