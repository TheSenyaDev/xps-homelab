FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY static ./static

ENV VAULT_DIR=/vault
EXPOSE 8003

# 1 worker keeps file writes simple; threads handle the small concurrent reads.
CMD ["gunicorn", "-b", "0.0.0.0:8003", "-w", "1", "--threads", "4", "app:app"]
