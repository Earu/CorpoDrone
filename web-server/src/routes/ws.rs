use actix_web::{web, HttpRequest, HttpResponse};
use actix_ws::AggregatedMessage;
use futures_util::StreamExt;
use tracing::debug;
use uuid::Uuid;

use crate::hub::Hub;

pub async fn handler(
    hub: web::Data<Hub>,
    req: HttpRequest,
    stream: web::Payload,
) -> Result<HttpResponse, actix_web::Error> {
    let (res, mut session, msg_stream) = actix_ws::handle(&req, stream)?;
    let id = Uuid::new_v4();
    hub.register(id, session.clone());

    let hub = hub.clone();
    actix_web::rt::spawn(async move {
        let mut stream = msg_stream.aggregate_continuations().max_continuation_size(64 * 1024);
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(AggregatedMessage::Close(_)) | Err(_) => break,
                Ok(AggregatedMessage::Ping(data)) => {
                    let _ = session.pong(&data).await;
                }
                Ok(_) => {}
            }
        }
        hub.unregister(&id);
        let _ = session.close(None).await;
        debug!("WS session {id} closed");
    });

    Ok(res)
}
