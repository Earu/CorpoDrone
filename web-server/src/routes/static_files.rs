use actix_web::HttpResponse;

const INDEX_HTML: &str = include_str!("../../../web-ui/index.html");
const APP_JS: &str = include_str!("../../../web-ui/app.js");
const STYLE_CSS: &str = include_str!("../../../web-ui/style.css");

pub async fn index() -> HttpResponse {
    HttpResponse::Ok().content_type("text/html; charset=utf-8").body(INDEX_HTML)
}

pub async fn app_js() -> HttpResponse {
    HttpResponse::Ok().content_type("application/javascript").body(APP_JS)
}

pub async fn style_css() -> HttpResponse {
    HttpResponse::Ok().content_type("text/css").body(STYLE_CSS)
}
