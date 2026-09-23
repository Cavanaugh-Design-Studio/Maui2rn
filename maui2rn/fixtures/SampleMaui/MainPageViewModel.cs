namespace SampleMaui;
public class MainPageViewModel {
    public string Query { get; set; } = "";
    public List<string> Customers { get; set; } = new();
    public object SearchCommand { get; set; } = new();
    public async Task OpenAsync() { await Shell.Current.GoToAsync("details"); }
}
