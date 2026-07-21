-- Windy Terms compliance (F13): "Link every image with either our webcam page
-- or timelapse player for full view" — store each cam's OWN detail-page URL
-- (webcam.urls.detail from include=urls) so renderWebcam's caption can link
-- the specific cam rather than the generic webcams hub.
ALTER TABLE beaches ADD COLUMN webcam_detail_url TEXT;
