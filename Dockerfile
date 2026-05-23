FROM python:3.11-slim

RUN pip install --no-cache-dir \
    fastapi==0.115.0 \
    uvicorn==0.30.6 \
    python-multipart==0.0.20 \
    beautifulsoup4==4.12.3

WORKDIR /app
COPY api/app.py /app/app.py

# Static assets the API serves from outside DATA_ROOT (so they can't be
# enumerated through the static mount).
RUN mkdir -p /etc/htmlz/skill
COPY api/widget.js                /etc/htmlz/widget.js
COPY skill/htmlz                  /etc/htmlz/skill/htmlz
COPY skill/SKILL.md               /etc/htmlz/skill/SKILL.md
COPY skill/install-remote.sh      /etc/htmlz/skill/install-remote.sh
RUN chmod +x /etc/htmlz/skill/htmlz /etc/htmlz/skill/install-remote.sh

# Data + state live on mounted volumes (see docker-compose.yml).
ENV HTMLZ_DATA_ROOT=/data \
    HTMLZ_MANIFEST=/state/manifest.json \
    HTMLZ_COMMENTS_DIR=/state/comments \
    HTMLZ_WIDGET=/etc/htmlz/widget.js \
    HTMLZ_SKILL_DIR=/etc/htmlz/skill \
    HTMLZ_INSTALL_SCRIPT=/etc/htmlz/skill/install-remote.sh

RUN mkdir -p /data /state/comments

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
