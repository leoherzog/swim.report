-- Each cam's own Windy detail-page URL (webcam.urls.detail from include=urls),
-- written nightly by the webcam cron and linked from renderWebcam's caption as
-- "View on Windy" to meet the Windy Terms' per-cam link requirement.
ALTER TABLE beaches ADD COLUMN webcam_detail_url TEXT;
