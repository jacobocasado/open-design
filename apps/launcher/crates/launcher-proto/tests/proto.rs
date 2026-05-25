use launcher_proto::{RuntimeApp, RuntimeEndpoint, RuntimeNamespace, RuntimeStamp};

#[test]
fn namespace_rules_match() {
    assert_eq!(
        RuntimeNamespace::new("release-beta-win").unwrap().as_str(),
        "release-beta-win"
    );
    assert!(RuntimeNamespace::new("").is_err());
    assert!(RuntimeNamespace::new(" beta").is_err());
    assert!(RuntimeNamespace::new("beta/local").is_err());
    assert!(RuntimeNamespace::new("-beta").is_err());
}

#[test]
fn endpoint_is_loopback_tcp() {
    assert_eq!(
        RuntimeEndpoint::new("tcp://127.0.0.1:17401")
            .unwrap()
            .port(),
        17401
    );
    assert!(RuntimeEndpoint::new("unix:///tmp/open-design.sock").is_err());
    assert!(RuntimeEndpoint::new("tcp://0.0.0.0:17401").is_err());
    assert!(RuntimeEndpoint::new("tcp://127.0.0.1:0").is_err());
    assert!(RuntimeEndpoint::new("tcp://127.0.0.1:017401").is_err());
}

#[test]
fn stamp_uses_endpoint_field() {
    let stamp = RuntimeStamp::new(
        RuntimeApp::Daemon,
        RuntimeEndpoint::new("tcp://127.0.0.1:17401").unwrap(),
        RuntimeNamespace::new("release-beta-win").unwrap(),
    );
    let json = serde_json::to_value(&stamp).unwrap();

    assert_eq!(json["endpoint"], "tcp://127.0.0.1:17401");
    assert!(json.get("ipc").is_none());
}
