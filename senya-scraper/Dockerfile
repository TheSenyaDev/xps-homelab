FROM python:3.12-slim

# No .pyc in the image or the mounted source tree.
ENV PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Every module, not a hand-listed one — the scrapers/ package grows a file per
# site, and naming them individually is how you ship an image that ImportErrors.
COPY *.py ./
COPY scraper ./scraper
COPY static ./static

ENV DB_PATH=/data/scraper.db
EXPOSE 8005
VOLUME ["/data"]

# Threads, not workers: a search is almost entirely spent waiting on the remote
# site, and one process keeps the SQLite writes serialized. The scraper sessions
# (and their hard-won cookies) also live in process memory, so extra workers
# would each have to get past bot protection separately.
CMD ["gunicorn", "-b", "0.0.0.0:8005", "-w", "1", "--threads", "8", "--timeout", "120", "app:app"]
