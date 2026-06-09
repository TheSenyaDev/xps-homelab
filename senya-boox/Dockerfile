FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY static ./static

ENV NOTES_DIR=/notes
EXPOSE 8004

# Read-only viewer: a few threads handle concurrent PDF reads fine.
CMD ["gunicorn", "-b", "0.0.0.0:8004", "-w", "1", "--threads", "4", "app:app"]
