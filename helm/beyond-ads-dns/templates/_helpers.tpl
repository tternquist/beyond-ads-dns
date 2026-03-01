{{/*
Expand the name of the chart.
*/}}
{{- define "beyond-ads-dns.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "beyond-ads-dns.fullname" -}}
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
Common labels
*/}}
{{- define "beyond-ads-dns.labels" -}}
helm.sh/chart: {{ include "beyond-ads-dns.name" . }}
app.kubernetes.io/name: {{ include "beyond-ads-dns.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "beyond-ads-dns.selectorLabels" -}}
app.kubernetes.io/name: {{ include "beyond-ads-dns.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Image
*/}}
{{- define "beyond-ads-dns.image" -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag }}
{{- end }}

{{/*
Use DaemonSet when hostNetwork + daemonSet
*/}}
{{- define "beyond-ads-dns.useDaemonSet" -}}
{{- and (eq .Values.dns.exposeMode "hostNetwork") (eq .Values.dns.daemonSet true) }}
{{- end }}

{{/*
Redis URL: when redis.enabled use the Bitnami Redis service (release-name-redis-master), else use values.redis.url
*/}}
{{- define "beyond-ads-dns.redisUrl" -}}
{{- if .Values.redis.enabled -}}
redis://{{ .Release.Name }}-redis-master:6379
{{- else -}}
{{ .Values.redis.url }}
{{- end -}}
{{- end }}
