#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use std::{ffi::c_void, mem::size_of};
use wincmux_runtime::platform::process_identity;
use windows::core::BOOL;
use windows::Win32::{
    Foundation::{HWND, LPARAM, RECT},
    Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetWindowDC,
        ReleaseDC, SelectObject, BITMAPINFO, DIB_RGB_COLORS, HGDIOBJ,
    },
    Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS},
    UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible, PW_RENDERFULLCONTENT,
    },
};

unsafe extern "system" fn collect_window(hwnd: HWND, context: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd).as_bool() {
        let mut title = [0u16; 128];
        let len = GetWindowTextW(hwnd, &mut title);
        if len <= 0 || String::from_utf16_lossy(&title[..len as usize]) != "WinCMux Tauri" {
            return BOOL(1);
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if process_identity(pid)
            .is_some_and(|process| process.image.eq_ignore_ascii_case("wincmux-tauri.exe"))
        {
            let windows = &mut *(context.0 as *mut Vec<(HWND, u32)>);
            windows.push((hwnd, pid));
        }
    }
    BOOL(1)
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let wanted_pid = args
        .windows(2)
        .find(|pair| pair[0] == "--pid")
        .map(|pair| pair[1].parse::<u32>())
        .transpose()?;
    let output_path = args
        .windows(2)
        .find(|pair| pair[0] == "--out")
        .map(|pair| pair[1].clone());
    let mut windows = Vec::<(HWND, u32)>::new();
    unsafe {
        EnumWindows(
            Some(collect_window),
            LPARAM((&mut windows as *mut _) as isize),
        )?;
    }
    windows.retain(|(_, pid)| wanted_pid.is_none_or(|wanted| *pid == wanted));
    if windows.len() != 1 {
        return Err(format!(
            "expected one visible WinCMux window, found {}; supply --pid if several are open",
            windows.len()
        )
        .into());
    }
    let (hwnd, pid) = windows[0];
    if unsafe { IsIconic(hwnd).as_bool() } {
        return Err("WinCMux window is minimized; restore it before capture".into());
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect)? };
    let width = (rect.right - rect.left) as u32;
    let height = (rect.bottom - rect.top) as u32;
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return Err("WinCMux window dimensions are invalid or too large".into());
    }
    let (screen_dc, memory_dc, bitmap, old) = unsafe {
        let screen_dc = GetWindowDC(Some(hwnd));
        if screen_dc.0.is_null() {
            return Err("GetWindowDC failed".into());
        }
        let memory_dc = CreateCompatibleDC(Some(screen_dc));
        if memory_dc.0.is_null() {
            ReleaseDC(Some(hwnd), screen_dc);
            return Err("CreateCompatibleDC failed".into());
        }
        let bitmap = CreateCompatibleBitmap(screen_dc, width as i32, height as i32);
        if bitmap.0.is_null() {
            let _ = DeleteDC(memory_dc);
            ReleaseDC(Some(hwnd), screen_dc);
            return Err("CreateCompatibleBitmap failed".into());
        }
        let old = SelectObject(memory_dc, HGDIOBJ(bitmap.0));
        (screen_dc, memory_dc, bitmap, old)
    };
    let captured = unsafe {
        let result = PrintWindow(hwnd, memory_dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT));
        SelectObject(memory_dc, old);
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = size_of::<windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width as i32;
        info.bmiHeader.biHeight = -(height as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        let lines = if result.as_bool() {
            GetDIBits(
                screen_dc,
                bitmap,
                0,
                height,
                Some(pixels.as_mut_ptr() as *mut c_void),
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory_dc);
        ReleaseDC(Some(hwnd), screen_dc);
        if lines != height as i32 {
            return Err("PrintWindow could not capture WinCMux".into());
        }
        pixels
    };
    let mut pixels = captured;
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    if pixels.chunks_exact(4).all(|pixel| pixel == &pixels[..4]) {
        return Err("window capture was blank; restore the window and retry".into());
    }
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(&pixels)?;
    }
    if let Some(path) = output_path {
        std::fs::write(path, &png_bytes)?;
        println!(
            "{}",
            serde_json::json!({"pid":pid,"width":width,"height":height,"mime_type":"image/png"})
        );
    } else {
        let data = base64::engine::general_purpose::STANDARD.encode(png_bytes);
        println!(
            "{}",
            serde_json::json!({"pid":pid,"width":width,"height":height,"mime_type":"image/png","data":data})
        );
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
