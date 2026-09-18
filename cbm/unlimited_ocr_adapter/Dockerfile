FROM python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
RUN useradd --uid 10002 --create-home ocr
COPY --chown=ocr:ocr service.py test_service.py /app/
USER ocr
EXPOSE 8002
CMD ["python", "-m", "uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8002"]
