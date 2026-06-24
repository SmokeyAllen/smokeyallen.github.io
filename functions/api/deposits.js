export async function onRequest(context) {
    const address = "MM1rvJGE6izAai1xBeyBF1G4UgBNDiyimg";

    const response = await fetch(
        `https://litecoinspace.org/api/address/${address}/txs`
    );

    const data = await response.json();

    return new Response(JSON.stringify(data), {
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60"
        }
    });
}
