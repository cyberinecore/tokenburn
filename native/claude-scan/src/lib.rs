use core::fmt;
use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde_json::value::RawValue;

const MARKER: &[u8] = b"\"usage\":{";
const ADVISOR: &[u8] = b"\"advisor_message\"";
const FORBIDDEN: [&[u8]; 11] = [
    b"id",
    b"cwd",
    b"model",
    b"speed",
    b"costUSD",
    b"version",
    b"sessionId",
    b"requestId",
    b"isApiErrorMessage",
    b"cache_read_input_tokens",
    b"cache_creation_input_tokens",
];

static mut INPUT: Vec<u8> = Vec::new();
static mut RECORDS: Vec<u32> = Vec::new();
static mut ARENA: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn input(size: usize) -> *mut u8 {
    let input = unsafe { &mut *core::ptr::addr_of_mut!(INPUT) };
    if input.len() < size {
        input.resize(size, 0);
    }
    input.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn records() -> *const u32 {
    unsafe { (*core::ptr::addr_of!(RECORDS)).as_ptr() }
}

#[no_mangle]
pub extern "C" fn arena() -> *const u8 {
    unsafe { (*core::ptr::addr_of!(ARENA)).as_ptr() }
}

fn is_ws(b: u8) -> bool {
    b == b' ' || b == b'\t' || b == b'\n' || b == b'\r'
}


fn may_hold_forbidden_null(line: &[u8]) -> bool {
    let n = line.len();
    let mut i = 0;
    while i + 4 <= n {
        if line[i] == b'\\' && i + 5 < n && line[i + 1] == b'u' && line[i + 2] == b'0' && line[i + 3] == b'0' && (b'2'..=b'7').contains(&line[i + 4]) && line[i + 5].is_ascii_hexdigit() {
            return true;
        }
        if &line[i..i + 4] == b"null" {
            let mut j = i;
            while j > 0 && is_ws(line[j - 1]) {
                j -= 1;
            }
            if j > 0 && line[j - 1] == b':' {
                j -= 1;
                while j > 0 && is_ws(line[j - 1]) {
                    j -= 1;
                }
                if j > 0 && line[j - 1] == b'"' {
                    let close = j - 1;
                    for key in FORBIDDEN.iter() {
                        if close >= key.len() + 1 && &line[close - key.len()..close] == *key && line[close - key.len() - 1] == b'"' {
                            return true;
                        }
                    }
                }
            }
        }
        i += 1;
    }
    false
}

enum Key {
    Timestamp,
    Version,
    CostUsd,
    RequestId,
    IsSidechain,
    IsApiErrorMessage,
    SessionId,
    Message,
    Id,
    Model,
    Usage,
    Other,
}

struct KeySeed {
    top: bool,
}

impl<'de> DeserializeSeed<'de> for KeySeed {
    type Value = Key;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Key, D::Error> {
        d.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for KeySeed {
    type Value = Key;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("key")
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Key, E> {
        Ok(if self.top {
            match v {
                "timestamp" => Key::Timestamp,
                "version" => Key::Version,
                "costUSD" => Key::CostUsd,
                "requestId" => Key::RequestId,
                "isSidechain" => Key::IsSidechain,
                "isApiErrorMessage" => Key::IsApiErrorMessage,
                "sessionId" => Key::SessionId,
                "message" => Key::Message,
                _ => Key::Other,
            }
        } else {
            match v {
                "id" => Key::Id,
                "model" => Key::Model,
                "usage" => Key::Usage,
                _ => Key::Other,
            }
        })
    }
}

#[derive(Default)]
struct Msg<'a> {
    id: Option<&'a RawValue>,
    model: Option<&'a RawValue>,
    usage: Option<&'a RawValue>,
}

enum MsgSlot<'a> {
    Null,
    Object(Msg<'a>),
}

struct MsgSeed;

impl<'de> DeserializeSeed<'de> for MsgSeed {
    type Value = MsgSlot<'de>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
}

fn put<'a, E: de::Error>(slot: &mut Option<&'a RawValue>, value: &'a RawValue) -> Result<(), E> {
    if slot.is_some() {
        return Err(E::custom("duplicate"));
    }
    *slot = Some(value);
    Ok(())
}

impl<'de> Visitor<'de> for MsgSeed {
    type Value = MsgSlot<'de>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("message object or null")
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(MsgSlot::Null)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut msg = Msg::default();
        while let Some(key) = map.next_key_seed(KeySeed { top: false })? {
            match key {
                Key::Id => put(&mut msg.id, map.next_value()?)?,
                Key::Model => put(&mut msg.model, map.next_value()?)?,
                Key::Usage => put(&mut msg.usage, map.next_value()?)?,
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(MsgSlot::Object(msg))
    }
}

#[derive(Default)]
struct Line<'a> {
    timestamp: Option<&'a RawValue>,
    version: Option<&'a RawValue>,
    cost_usd: Option<&'a RawValue>,
    request_id: Option<&'a RawValue>,
    is_sidechain: Option<&'a RawValue>,
    is_api_error_message: Option<&'a RawValue>,
    session_id: Option<&'a RawValue>,
    message: Option<MsgSlot<'a>>,
}

struct LineVisitor;

impl<'de> Visitor<'de> for LineVisitor {
    type Value = Line<'de>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("line object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut line = Line::default();
        while let Some(key) = map.next_key_seed(KeySeed { top: true })? {
            match key {
                Key::Timestamp => put(&mut line.timestamp, map.next_value()?)?,
                Key::Version => put(&mut line.version, map.next_value()?)?,
                Key::CostUsd => put(&mut line.cost_usd, map.next_value()?)?,
                Key::RequestId => put(&mut line.request_id, map.next_value()?)?,
                Key::IsSidechain => put(&mut line.is_sidechain, map.next_value()?)?,
                Key::IsApiErrorMessage => put(&mut line.is_api_error_message, map.next_value()?)?,
                Key::SessionId => put(&mut line.session_id, map.next_value()?)?,
                Key::Message => {
                    if line.message.is_some() {
                        return Err(de::Error::custom("duplicate"));
                    }
                    line.message = Some(map.next_value_seed(MsgSeed)?);
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(line)
    }
}

fn field(out: &mut Vec<u8>, first: &mut bool, name: &[u8], value: Option<&RawValue>) {
    if let Some(value) = value {
        if !*first {
            out.push(b',');
        }
        *first = false;
        out.push(b'"');
        out.extend_from_slice(name);
        out.extend_from_slice(b"\":");
        out.extend_from_slice(value.get().as_bytes());
    }
}

fn compact(bytes: &[u8], out: &mut Vec<u8>) -> bool {
    let mut de = serde_json::Deserializer::from_slice(bytes);
    let line = match de.deserialize_map(LineVisitor) {
        Ok(line) => line,
        Err(_) => return false,
    };
    if de.end().is_err() {
        return false;
    }
    out.push(b'{');
    let mut first = true;
    field(out, &mut first, b"timestamp", line.timestamp);
    field(out, &mut first, b"version", line.version);
    field(out, &mut first, b"costUSD", line.cost_usd);
    field(out, &mut first, b"requestId", line.request_id);
    field(out, &mut first, b"isSidechain", line.is_sidechain);
    field(out, &mut first, b"isApiErrorMessage", line.is_api_error_message);
    field(out, &mut first, b"sessionId", line.session_id);
    match line.message {
        None => {}
        Some(MsgSlot::Null) => {
            if !first {
                out.push(b',');
            }
            out.extend_from_slice(b"\"message\":null");
        }
        Some(MsgSlot::Object(msg)) => {
            if !first {
                out.push(b',');
            }
            out.extend_from_slice(b"\"message\":{");
            let mut inner = true;
            field(out, &mut inner, b"id", msg.id);
            field(out, &mut inner, b"model", msg.model);
            field(out, &mut inner, b"usage", msg.usage);
            out.push(b'}');
        }
    }
    out.push(b'}');
    true
}

#[no_mangle]
pub extern "C" fn scan(len: usize) -> u32 {
    let data = unsafe { &(&*core::ptr::addr_of!(INPUT))[..len] };
    let records = unsafe { &mut *core::ptr::addr_of_mut!(RECORDS) };
    let arena = unsafe { &mut *core::ptr::addr_of_mut!(ARENA) };
    records.clear();
    arena.clear();
    let mut count = 0u32;
    let mut from = 0;
    let marker = memchr::memmem::Finder::new(MARKER);
    let advisor_finder = memchr::memmem::Finder::new(ADVISOR);
    while from < data.len() {
        let at = match marker.find(&data[from..]) {
            Some(p) => p + from,
            None => break,
        };
        let start = memchr::memrchr(b'\n', &data[..at]).map_or(0, |p| p + 1);
        let end = memchr::memchr(b'\n', &data[at..]).map_or(data.len(), |p| p + at);
        let line = &data[start..end];
        let mini_start = arena.len();
        let fast = !may_hold_forbidden_null(line) && compact(line, arena);
        if !fast {
            arena.truncate(mini_start);
        }
        let advisor = fast && advisor_finder.find(line).is_some();
        records.extend_from_slice(&[fast as u32, start as u32, end as u32, mini_start as u32, (arena.len() - mini_start) as u32, advisor as u32]);
        count += 1;
        from = end + 1;
    }
    count
}
