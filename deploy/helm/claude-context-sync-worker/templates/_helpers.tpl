{{/*
Expand the name of the chart.
*/}}
{{- define "claude-context-sync-worker.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "claude-context-sync-worker.fullname" -}}
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
{{- define "claude-context-sync-worker.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "claude-context-sync-worker.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "claude-context-sync-worker.selectorLabels" -}}
app.kubernetes.io/name: {{ include "claude-context-sync-worker.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "claude-context-sync-worker.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "claude-context-sync-worker.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the Kubernetes Secret the CronJob should envFrom/mount, in priority
order: externalSecret.enabled > existingSecret > secret.create. Empty string
if none configured.
*/}}
{{- define "claude-context-sync-worker.secretName" -}}
{{- if .Values.externalSecret.enabled -}}
{{- .Values.externalSecret.secretName | default (include "claude-context-sync-worker.fullname" .) -}}
{{- else if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else if .Values.secret.create -}}
{{- include "claude-context-sync-worker.fullname" . -}}
{{- end -}}
{{- end }}

{{/*
Name of the PVC holding repo checkouts.
*/}}
{{- define "claude-context-sync-worker.pvcName" -}}
{{- .Values.persistence.existingClaim | default (include "claude-context-sync-worker.fullname" .) -}}
{{- end }}
