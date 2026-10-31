# Agentgateway guards and MCP

Examples for `AgentgatewayPolicy` prompt guards and `AgentgatewayBackend` MCP servers. Model, cost, and virtual-model configuration lives in [`stacks/ai/components/agentgateway/agentgateway.md`](../stacks/ai/components/agentgateway/agentgateway.md).

## Prompt guards

Prompt guards are regex filters under `spec.backend.ai.promptGuard`. Target the agentgateway Gateway so all model routes are covered; the dashboard route is served by the sidecar and is unaffected. `Reject` blocks; `Mask` redacts buffered responses. Streamed responses cannot be masked, so use `Reject` for them.

```yaml
apiVersion: agentgateway.dev/v1alpha1
kind: AgentgatewayPolicy
metadata:
    name: prompt-guard
    namespace: agentgateway
spec:
    targetRefs:
        - group: gateway.networking.k8s.io
          kind: Gateway
          name: agentgateway-proxy
    backend:
        ai:
            promptGuard:
                request:
                    - regex:
                          action: Reject
                          builtins: [CreditCard, Ssn, Email, PhoneNumber]
                      response:
                          message: 'PII detected'
                          statusCode: 422
                    - regex:
                          action: Reject
                          matches:
                              - '(?i)ignore (all )?previous instructions'
                      response:
                          message: 'Prompt injection detected'
                          statusCode: 403
```

Other built-ins: `CaSin`. Guards can also use OpenAI moderation, Bedrock Guardrails, Google Model Armor, or a webhook. Reference: <https://agentgateway.dev/docs/kubernetes/latest/documentation/llm/guardrails/>.

## MCP servers

An MCP server is a Service with `appProtocol: agentgateway.dev/mcp`, referenced by an `AgentgatewayBackend`, then routed through the Gateway.

```yaml
apiVersion: agentgateway.dev/v1alpha1
kind: AgentgatewayBackend
metadata:
    name: mcp-backend
    namespace: agentgateway
spec:
    mcp:
        targets:
            - name: mcp-target
              static:
                  backendRef:
                      name: mcp-server
                  port: 80
                  protocol: SSE
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
    name: mcp
    namespace: agentgateway
spec:
    parentRefs:
        - name: agentgateway-proxy
          namespace: agentgateway
    rules:
        - matches:
              - path:
                    type: PathPrefix
                    value: /mcp
          backendRefs:
              - name: mcp-backend
                group: agentgateway.dev
                kind: AgentgatewayBackend
```

Expose the Gateway through Traefik as `ai.<domain>`; MCP clients then connect to `https://ai.<domain>/mcp` using Streamable HTTP. The same route also serves `/v1` LLM traffic, and the Gateway's API-key policy applies to `/mcp` too. If the backend is in another namespace, add a `ReferenceGrant`.

Use `AgentgatewayPolicy` on the MCP route or backend for JWT/OAuth, tool-level CEL access rules, rate limits, and audit logging. Reference: <https://agentgateway.dev/docs/kubernetes/latest/documentation/mcp/static-mcp/> and <https://agentgateway.dev/docs/kubernetes/latest/documentation/mcp/tool-access/>.
