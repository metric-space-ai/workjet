// Origin: CTOX
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

fn main() -> std::process::ExitCode {
    workjet_provider_gateway::internal::cmd::fetch_antigravity_models::standalone_main(
        std::env::args().skip(1),
    )
}
