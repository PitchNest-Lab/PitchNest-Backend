// Placeholder used ONLY when Terraform first creates pitchnest-prod-api.
// It holds no application code, secrets or dependencies. Until the deployment
// pipeline publishes a reviewed release and moves the "live" alias, every
// request receives 503 so a half-provisioned PROD can never serve traffic.
export const handler = async () => ({
  statusCode: 503,
  headers: {
    "content-type": "application/json",
    "cache-control": "no-store",
  },
  body: JSON.stringify({
    error: "Service not deployed",
    service: "pitchnest-prod-api",
  }),
});
