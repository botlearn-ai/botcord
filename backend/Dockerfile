FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY hub/ hub/
COPY app/ app/

CMD ["uv", "run", "uvicorn", "hub.main:app", "--host", "0.0.0.0", "--port", "8000"]
