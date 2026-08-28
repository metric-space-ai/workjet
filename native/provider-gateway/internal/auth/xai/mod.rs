// Origin: CTOX module graph for the upstream xAI auth package.
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

#[path = "xai.rs"]
mod flow;
#[cfg(feature = "xai-http-transport")]
mod login_transport;
mod token;
mod types;

pub use flow::*;
#[cfg(feature = "xai-http-transport")]
pub use login_transport::{XaiLoginHttpTransport, XaiLoginTransportBuildError};
pub use token::*;
pub use types::*;

#[cfg(test)]
mod xai_auth_test;
