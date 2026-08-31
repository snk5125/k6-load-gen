# Deployment guide — running k6-load-gen as an ECS task

This guide covers running the shipped container image as an ECS task, and the
environment surface that configures it.

**Out of scope:** provisioning the cluster, VPC, subnets, security groups, IAM
roles, or the target aggregator. This guide assumes those already exist.
Infrastructure provisioning is deliberately not part of this repository — the
image is configured entirely through environment variables, and nothing here
manages AWS resources on your behalf.

Every region, account ID and image URI below is a placeholder. Substitute your
own; none are baked into the image.

---

## Environment variables

The container command is never overridden. Configuration is environment only.

### Required

| Variable | Purpose |
|---|---|
| `PROFILE` | Which bundled profile to load — one of `local-null`, `otlp-grpc`, `otlp-http`, `hec`, `syslog`, `mixed-estate` |
| `RUN_ID` | Correlation key, unique per run. Appears in every event and in the run's artifacts |

### Run shaping

| Variable | Default | Purpose |
|---|---|---|
| `TARGET` | profile's `target.endpoint` | Override the destination endpoint |
| `TYPES` | every type the profile declares | Comma-separated subset of log types to run this invocation |
| `DURATION_SCALE` | `1` | Multiply every stage duration. `0.02` turns a 4-hour soak into a few minutes — use it to prove wiring before committing to a real run |

### Per-type overrides

A profile's `types` map can declare several log types, each with its own rate
and load shape. Override any of them per run.

**The variable prefix is the type name uppercased, with hyphens replaced by
underscores** — so `nginx-access` becomes `NGINX_ACCESS`.

| Variable | Purpose |
|---|---|
| `<TYPE>_RATE` | Pin an absolute base rate for this type. Wins over `<TYPE>_KNEE_EPS` |
| `<TYPE>_KNEE_EPS` | Override this type's knee-anchor estimate |
| `<TYPE>_SCENARIO` | Override this type's load shape |
| `<TYPE>_BATCH_SIZE` | Override this type's events-per-send batch size |

Examples: `AUDITD_RATE`, `NGINX_ACCESS_SCENARIO`, `CLOUDTRAIL_BATCH_SIZE`.

Setting a `<TYPE>_*` variable for a type that is not running produces a warning
in the run's artifacts rather than silent no-op.

### These three now fail at startup

| Variable | Replacement |
|---|---|
| `SCENARIO` | `<TYPE>_SCENARIO` |
| `RATE` | `<TYPE>_RATE` |
| `KNEE_EPS` | `<TYPE>_KNEE_EPS` |

They were global overrides before a profile could declare more than one log
type; `RATE=5000` is ambiguous once three types are running. Setting any of
them raises an error during initialisation, so **a task definition carrying one
is a container that will not start.** Check older task definitions before
reusing them.

### Fleet slicing

| Variable | Default | Purpose |
|---|---|---|
| `GEN_INDEX` | `0` | This generator's index within the fleet |
| `GEN_COUNT` | `1` | Total generators in the fleet |

Each generator produces its slice of the offered rate, so N tasks with
`GEN_COUNT=N` together offer the profile's full rate. `GEN_INDEX` is stamped on
every event, so a receiver can attribute traffic per task.

### Artifacts

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RESULTS_URI` | no | — | `s3://bucket/prefix` or a local path. Unset means artifacts stay in the container's working directory and are lost when the task stops |
| `EMIT_TIMELINE` | no | profile, else `1` | Emit the bucketed timeline. Costs throughput at very high rates |
| `KEEP_RAW` | no | `0` | Also ship the gzipped raw sample stream |
| `TIMELINE_BUCKET_SEC` | no | `15` | Timeline bucket width in seconds |
| `AWS_REGION` | **when `RESULTS_URI` is `s3://`** | — | See the gotcha below — this one bites |

### Credentials

A profile never holds a credential. It *names* the environment variable that
carries one — `profiles/hec.json` sets `"token_env": "HEC_TOKEN"` — and the
value arrives at runtime.

Supply it through the task definition's `secrets` block, not `environment`.
See "Credentials belong in `secrets`" below.

---

## Task definition

Fargate, `awsvpc`, arm64. The image supports both `arm64` and `amd64`;
architecture is detected at image build time.

```json
{
  "family": "k6-load-gen",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "2048",
  "memory": "4096",
  "runtimePlatform": {
    "cpuArchitecture": "ARM64",
    "operatingSystemFamily": "LINUX"
  },
  "executionRoleArn": "arn:aws:iam::<account-id>:role/<task-execution-role>",
  "taskRoleArn": "arn:aws:iam::<account-id>:role/<task-role>",
  "containerDefinitions": [
    {
      "name": "k6-load-gen",
      "image": "<account-id>.dkr.ecr.<your-region>.amazonaws.com/k6-load-gen:latest",
      "essential": true,
      "environment": [
        { "name": "PROFILE",       "value": "mixed-estate" },
        { "name": "RUN_ID",        "value": "placeholder-overridden-per-run" },
        { "name": "TARGET",        "value": "<collector-host>:4317" },
        { "name": "RESULTS_URI",   "value": "s3://<results-bucket>/k6" },
        { "name": "AWS_REGION",    "value": "<your-region>" }
      ],
      "secrets": [
        {
          "name": "HEC_TOKEN",
          "valueFrom": "arn:aws:secretsmanager:<your-region>:<account-id>:secret:<secret-name>"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/k6-load-gen",
          "awslogs-region": "<your-region>",
          "awslogs-stream-prefix": "k6"
        }
      }
    }
  ]
}
```

Register it:

```bash
aws ecs register-task-definition \
  --cli-input-json file://task-definition.json \
  --region "$AWS_REGION"
```

The `taskRoleArn` needs `s3:PutObject` on the results prefix if you set
`RESULTS_URI`, plus read access to the secret if you use one.

---

## Running a task

### Baseline

```bash
aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition k6-load-gen \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=DISABLED}" \
  --region "$AWS_REGION"
```

### Overriding environment per run

This is the pattern that makes repeated runs practical: vary the run without
re-registering the task definition. `--overrides` replaces the named variables
and leaves the rest of the definition intact.

```bash
aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition k6-load-gen \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=DISABLED}" \
  --region "$AWS_REGION" \
  --overrides '{
    "containerOverrides": [{
      "name": "k6-load-gen",
      "environment": [
        { "name": "RUN_ID",               "value": "sweep-2026-08-31-a" },
        { "name": "TYPES",                "value": "auditd,nginx-access" },
        { "name": "AUDITD_RATE",          "value": "5000" },
        { "name": "NGINX_ACCESS_SCENARIO","value": "spike" },
        { "name": "DURATION_SCALE",       "value": "0.5" }
      ]
    }]
  }'
```

### A wiring check before a real run

`DURATION_SCALE` compresses every stage, so a long shape becomes a short one.
This proves the target, credentials, network path and S3 permissions without
committing to a full run.

```bash
aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition k6-load-gen \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=DISABLED}" \
  --region "$AWS_REGION" \
  --overrides '{
    "containerOverrides": [{
      "name": "k6-load-gen",
      "environment": [
        { "name": "RUN_ID",         "value": "wiring-check" },
        { "name": "DURATION_SCALE", "value": "0.02" }
      ]
    }]
  }'
```

### A fleet

Each task takes the same `GEN_COUNT` and its own `GEN_INDEX`. Together they
offer the profile's full rate; individually each offers its slice.

```bash
CLUSTER=... SUBNET_ID=... SG_ID=... GEN_COUNT=4
RUN_ID="fleet-$(date -u +%Y%m%dT%H%M%SZ)"

for i in $(seq 0 $((GEN_COUNT - 1))); do
  aws ecs run-task \
    --cluster "$CLUSTER" \
    --task-definition k6-load-gen \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=DISABLED}" \
    --region "$AWS_REGION" \
    --overrides "{
      \"containerOverrides\": [{
        \"name\": \"k6-load-gen\",
        \"environment\": [
          { \"name\": \"RUN_ID\",    \"value\": \"$RUN_ID\" },
          { \"name\": \"GEN_INDEX\", \"value\": \"$i\" },
          { \"name\": \"GEN_COUNT\", \"value\": \"$GEN_COUNT\" }
        ]
      }]
    }"
done
```

Use one `RUN_ID` across the fleet so the slices correlate as a single run.

---

## Exit codes

The container's exit code is the run's verdict, and ECS surfaces it on the
stopped task.

| Code | Meaning |
|---|---|
| `0` | Pass |
| `99` | A threshold was breached — the run completed and found what it was looking for |
| other non-zero | The run failed to complete |

`99` is the CI gate. Artifact upload never masks it: a failed upload is
reported, but the run's verdict is what the container exits with.

Read it back with:

```bash
aws ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks "$TASK_ARN" \
  --region "$AWS_REGION" \
  --query 'tasks[0].containers[0].exitCode'
```

Note that a threshold breach is not the same as an invalid run. The summary's
`validity` block answers *"is this measurement trustworthy?"* separately from
*"did the target pass?"* — a run that drops iterations measured the generator,
not the target, and is invalid regardless of its exit code.

---

## Gotchas

### `AWS_REGION` must be explicit

ECS does not inject a region, and Fargate `awsvpc` tasks cannot reach IMDS to
resolve one. Without it, every `aws s3 cp` fails region resolution and nothing
is persisted — the load run itself succeeds and its artifacts vanish.

The wrapper warns when `RESULTS_URI` is an `s3://` URI and neither `AWS_REGION`
nor `AWS_DEFAULT_REGION` is set. Set it in the task definition.

### Credentials belong in `secrets`, not `environment`

A task definition is a document people paste into version control, tickets and
chat. An `environment` entry holding a token puts it in all three.

Use the `secrets` block with a Secrets Manager or SSM Parameter Store ARN, as
in the task definition above. ECS injects the value as an environment variable
at runtime, so the application sees exactly what `token_env` names, and the
plaintext never enters the definition.

This is the whole reason profiles name a variable rather than holding a value.

### Old task definitions may not start

If a definition predates multi-type profiles it may carry `SCENARIO`, `RATE` or
`KNEE_EPS`, which now raise an error during initialisation. The task will start
and immediately stop; the reason appears in the container's logs.

### Sizing

The generator is CPU-bound. A task that cannot sustain the offered rate drops
iterations, and a run with dropped iterations measured the generator rather
than the target — the summary marks it invalid. If `validity.valid` is false,
raise `cpu` or spread the load across more tasks with `GEN_COUNT` rather than
trusting the numbers.
