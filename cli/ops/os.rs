// Copyright 2018-2019 the Deno authors. All rights reserved. MIT license.
use super::dispatch_flatbuffers::serialize_response;
use super::dispatch_json::{Deserialize, JsonOp, Value};
use super::utils::*;
use crate::ansi;
use crate::fs as deno_fs;
use crate::msg;
use crate::state::ThreadSafeState;
use crate::version;
use atty;
use deno::*;
use flatbuffers::FlatBufferBuilder;
use log;
use std::collections::HashMap;
use std::env;
use url::Url;

pub fn op_start(
  state: &ThreadSafeState,
  base: &msg::Base<'_>,
  data: Option<PinnedBuf>,
) -> CliOpResult {
  assert!(data.is_none());
  let mut builder = FlatBufferBuilder::new();

  let state = state;
  let argv = state.argv.iter().map(String::as_str).collect::<Vec<_>>();
  let argv_off = builder.create_vector_of_strings(argv.as_slice());

  let cwd_path = env::current_dir().unwrap();
  let cwd_off =
    builder.create_string(deno_fs::normalize_path(cwd_path.as_ref()).as_ref());

  let v8_version = version::v8();
  let v8_version_off = builder.create_string(v8_version);

  let deno_version = version::DENO;
  let deno_version_off = builder.create_string(deno_version);

  let main_module = state
    .main_module()
    .map(|m| builder.create_string(&m.to_string()));

  let xeval_delim = state
    .flags
    .xeval_delim
    .clone()
    .map(|m| builder.create_string(&m));

  let debug_flag = state
    .flags
    .log_level
    .map_or(false, |l| l == log::Level::Debug);

  let inner = msg::StartRes::create(
    &mut builder,
    &msg::StartResArgs {
      cwd: Some(cwd_off),
      pid: std::process::id(),
      argv: Some(argv_off),
      main_module,
      debug_flag,
      version_flag: state.flags.version,
      v8_version: Some(v8_version_off),
      deno_version: Some(deno_version_off),
      no_color: !ansi::use_color(),
      xeval_delim,
      ..Default::default()
    },
  );

  ok_buf(serialize_response(
    base.cmd_id(),
    &mut builder,
    msg::BaseArgs {
      inner_type: msg::Any::StartRes,
      inner: Some(inner.as_union_value()),
      ..Default::default()
    },
  ))
}

pub fn op_home_dir(
  state: &ThreadSafeState,
  base: &msg::Base<'_>,
  data: Option<PinnedBuf>,
) -> CliOpResult {
  assert!(data.is_none());
  let cmd_id = base.cmd_id();

  state.check_env()?;

  let builder = &mut FlatBufferBuilder::new();
  let path = dirs::home_dir()
    .unwrap_or_default()
    .into_os_string()
    .into_string()
    .unwrap_or_default();
  let path = Some(builder.create_string(&path));
  let inner = msg::HomeDirRes::create(builder, &msg::HomeDirResArgs { path });

  ok_buf(serialize_response(
    cmd_id,
    builder,
    msg::BaseArgs {
      inner: Some(inner.as_union_value()),
      inner_type: msg::Any::HomeDirRes,
      ..Default::default()
    },
  ))
}

pub fn op_exec_path(
  state: &ThreadSafeState,
  _args: Value,
  _zero_copy: Option<PinnedBuf>,
) -> Result<JsonOp, ErrBox> {
  state.check_env()?;
  let current_exe = env::current_exe().unwrap();
  // Now apply URL parser to current exe to get fully resolved path, otherwise
  // we might get `./` and `../` bits in `exec_path`
  let exe_url = Url::from_file_path(current_exe).unwrap();
  let path = exe_url.to_file_path().unwrap();
  Ok(JsonOp::Sync(json!(path)))
}

pub fn op_set_env(
  state: &ThreadSafeState,
  base: &msg::Base<'_>,
  data: Option<PinnedBuf>,
) -> CliOpResult {
  assert!(data.is_none());
  let inner = base.inner_as_set_env().unwrap();
  let key = inner.key().unwrap();
  let value = inner.value().unwrap();
  state.check_env()?;
  env::set_var(key, value);
  ok_buf(empty_buf())
}

pub fn op_env(
  state: &ThreadSafeState,
  _args: Value,
  _zero_copy: Option<PinnedBuf>,
) -> Result<JsonOp, ErrBox> {
  state.check_env()?;
  let v = env::vars().collect::<HashMap<String, String>>();
  Ok(JsonOp::Sync(json!(v)))
}

#[derive(Deserialize)]
struct Exit {
  code: i32,
}

pub fn op_exit(
  _s: &ThreadSafeState,
  args: Value,
  _zero_copy: Option<PinnedBuf>,
) -> Result<JsonOp, ErrBox> {
  let args: Exit = serde_json::from_value(args)?;
  std::process::exit(args.code)
}

pub fn op_is_tty(
  _s: &ThreadSafeState,
  _args: Value,
  _zero_copy: Option<PinnedBuf>,
) -> Result<JsonOp, ErrBox> {
  Ok(JsonOp::Sync(json!({
    "stdin": atty::is(atty::Stream::Stdin),
    "stdout": atty::is(atty::Stream::Stdout),
    "stderr": atty::is(atty::Stream::Stderr),
  })))
}
