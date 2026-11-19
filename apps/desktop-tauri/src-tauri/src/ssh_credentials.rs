use windows::{
    core::{HRESULT, HSTRING, PWSTR},
    Win32::{
        Foundation::ERROR_NOT_FOUND,
        Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
            CRED_TYPE_GENERIC,
        },
    },
};
use zeroize::Zeroizing;

pub fn read(key: &str) -> Result<Option<Zeroizing<String>>, String> {
    let mut credential = std::ptr::null_mut();
    unsafe {
        match CredReadW(
            &HSTRING::from(key),
            CRED_TYPE_GENERIC,
            None,
            &mut credential,
        ) {
            Ok(()) => {}
            Err(err) if err.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => return Ok(None),
            Err(err) => return Err(err.to_string()),
        }
        let entry = &*credential;
        let secret = if entry.CredentialBlobSize == 0 || entry.CredentialBlob.is_null() {
            Ok(None)
        } else {
            let bytes =
                std::slice::from_raw_parts(entry.CredentialBlob, entry.CredentialBlobSize as usize);
            std::str::from_utf8(bytes)
                .map(|value| Some(Zeroizing::new(value.to_owned())))
                .map_err(|_| "저장된 SSH 비밀번호를 읽을 수 없습니다.".to_owned())
        };
        CredFree(credential.cast());
        secret
    }
}

pub fn save(key: &str, password: &str) -> Result<(), String> {
    let name = HSTRING::from(key);
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(name.as_ptr().cast_mut()),
        CredentialBlobSize: password.len() as u32,
        CredentialBlob: password.as_ptr().cast_mut(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    unsafe { CredWriteW(&credential, 0) }.map_err(|err| err.to_string())
}

pub fn remove(key: &str) -> Result<(), String> {
    match unsafe { CredDeleteW(&HSTRING::from(key), CRED_TYPE_GENERIC, None) } {
        Ok(()) => Ok(()),
        Err(err) if err.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}
