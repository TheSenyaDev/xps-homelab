FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY static ./static

ENV DB_PATH=/data/daily.db
EXPOSE 8001
VOLUME ["/data"]

# 1 worker keeps SQLite writes serialized and simple; bump if you need it.
CMD ["gunicorn", "-b", "0.0.0.0:8001", "-w", "1", "--threads", "4", "app:app"]
