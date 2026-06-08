FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY wsgi.py .
COPY finance ./finance

ENV DB_PATH=/data/finance.db
ENV IMPORT_DIR=/import
EXPOSE 8002
VOLUME ["/data"]

# 1 worker keeps SQLite writes serialized; threads handle concurrent reads.
CMD ["gunicorn", "-b", "0.0.0.0:8002", "-w", "1", "--threads", "4", "wsgi:app"]
