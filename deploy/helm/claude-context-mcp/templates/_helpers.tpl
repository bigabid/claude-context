{{/*
Expand the name of the chart.
*/}}
{{- define "claude-context-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "claude-context-mcp.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "claude-context-mcp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "claude-context-mcp.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "claude-context-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "claude-context-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "claude-context-mcp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "claude-context-mcp.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the Kubernetes Secret the Deployment should envFrom, whichever of the
three secret-sourcing modes is active (checked in this priority order):
externalSecret.enabled > existingSecret > secret.create. Empty string if none
are configured (deployment.yaml then omits envFrom entirely).
*/}}
{{- define "claude-context-mcp.secretName" -}}
{{- if .Values.externalSecret.enabled -}}
{{- .Values.externalSecret.secretName | default (include "claude-context-mcp.fullname" .) -}}
{{- else if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else if .Values.secret.create -}}
{{- include "claude-context-mcp.fullname" . -}}
{{- end -}}
{{- end }}
